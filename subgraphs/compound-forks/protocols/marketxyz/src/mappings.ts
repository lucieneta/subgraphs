// fuse handlers
import {
  Address,
  BigDecimal,
  BigInt,
  ethereum,
  log,
} from "@graphprotocol/graph-ts";
import {
  ProtocolData,
  _getOrCreateProtocol,
  _handleNewReserveFactor,
  _handleNewCollateralFactor,
  _handleNewPriceOracle,
  _handleMarketListed,
  MarketListedData,
  TokenData,
  _handleNewLiquidationIncentive,
  _handleMint,
  _handleRedeem,
  _handleBorrow,
  _handleRepayBorrow,
  _handleLiquidateBorrow,
  UpdateMarketData,
  getOrElse,
  _handleActionPaused,
  updateProtocol,
  snapshotFinancials,
  setSupplyInterestRate,
  convertRatePerUnitToAPY,
  setBorrowInterestRate,
  getOrCreateMarketDailySnapshot,
  getOrCreateMarketHourlySnapshot,
} from "../../../src/mapping";
import { PoolRegistered as PoolRegisteredEvent } from "../../../generated/PoolDirectory/PoolDirectory";
import {
  ETH_ADDRESS,
  ETH_NAME,
  ETH_SYMBOL,
  getNetworkSpecificConstant,
  METHODOLOGY_VERSION,
  PROTOCOL_NAME,
  PROTOCOL_SLUG,
  SCHEMA_VERSION,
  SUBGRAPH_VERSION,
  ZERO_ADDRESS,
} from "./constants";
import {
  ActionPaused1,
  Comptroller,
  MarketListed,
  NewCollateralFactor,
  NewLiquidationIncentive,
  NewPriceOracle,
} from "../../../generated/templates/Comptroller/Comptroller";
import {
  AccrueInterest,
  Borrow,
  LiquidateBorrow,
  Mint,
  NewReserveFactor,
  Redeem,
  RepayBorrow,
} from "../../../generated/templates/CToken/CToken";
import {
  NewAdminFee,
  NewFuseFee,
  CToken,
} from "../../../generated/templates/CToken/CToken";
import {
  Comptroller as ComptrollerTemplate,
  CToken as CTokenTemplate,
} from "../../../generated/templates";
import { LendingProtocol, Token } from "../../../generated/schema";
import { ERC20 } from "../../../generated/templates/Comptroller/ERC20";
import {
  BIGDECIMAL_HUNDRED,
  BIGDECIMAL_ONE,
  BIGDECIMAL_ZERO,
  BIGINT_ZERO,
  cTokenDecimals,
  DAYS_PER_YEAR,
  ETHEREUM_BLOCKS_PER_YEAR,
  exponentToBigDecimal,
  InterestRateSide,
  InterestRateType,
  INT_TWO,
  mantissaFactor,
  mantissaFactorBD,
  Network,
  RewardTokenType,
} from "../../../src/constants";
import {
  InterestRate,
  Market,
  RewardToken,
  _FusePool,
  PoolRegistered,
} from "../../../generated/schema";
import { PriceOracle } from "../../../generated/templates/CToken/PriceOracle";

import {
  getOrCreateCircularBuffer,
  getRewardsPerDay,
  RewardIntervalType,
} from "./rewards";
import {
  MarketComptroller,
  WhitelistEnforcementChanged,
} from "../../../generated/templates/CToken/MarketComptroller";
import { getUsdPricePerToken } from "./prices";

//////////////////////////////////
//// Chain-specific Constants ////
//////////////////////////////////

let constants = getNetworkSpecificConstant();
const FACTORY_CONTRACT = constants.poolDirectoryAddress;
const PROTOCOL_NETWORK = constants.network;
const ETH_PRICEORACLE = constants.ethPriceOracle;

//////////////////////
//// Fuse Enum(s) ////
//////////////////////

export namespace RariFee {
  export const FUSE_FEE = "FUSE_FEE";
  export const ADMIN_FEE = "ADMIN_FEE";
}

/////////////////////////////////
//// Pool Directory Handlers ////
/////////////////////////////////

// creates a new LendingProtocol for a new fuse "pool"
export function handlePoolRegistered(event: PoolRegisteredEvent): void {
  // create Comptroller template
  ComptrollerTemplate.create(event.params.pool.comptroller);

  let troller = MarketComptroller.bind(event.params.pool.comptroller);

  // populate pool data
  let poolData = new ProtocolData(
    Address.fromString(FACTORY_CONTRACT),
    PROTOCOL_NAME,
    PROTOCOL_SLUG,
    SCHEMA_VERSION,
    SUBGRAPH_VERSION,
    METHODOLOGY_VERSION,
    PROTOCOL_NETWORK,
    troller.try_liquidationIncentiveMantissa(),
    troller.try_oracle()
  );

  // only needed to create the new pool (ie, pool's Comptroller implementation)
  _getOrCreateProtocol(poolData);

  // create helper fuse pool entity
  let pool = new _FusePool(event.params.pool.comptroller.toHexString());

  pool.name = event.params.pool.name;
  pool.createdAt = event.block.timestamp;

  pool.totalDepositBalanceUSD = BIGDECIMAL_ZERO;
  pool.totalValueLockedUSD = BIGDECIMAL_ZERO;
  pool.totalBorrowBalanceUSD = BIGDECIMAL_ZERO;

  pool.poolNumber = event.params.index.toString();
  pool.marketIDs = [];

  pool.admin = troller.try_admin().value.toHexString();
  pool.pendingAdmin = troller.try_pendingAdmin().value.toHexString();
  pool.enforceWhitelist = troller.try_enforceWhitelist().value;
  pool.closeFactor = troller.try_closeFactorMantissa().value.toBigDecimal();

  // set price oracle for pool entity
  let tryOracle = troller.try_oracle();
  if (tryOracle.reverted) {
    pool.priceOracle = "";
  } else {
    pool.priceOracle = tryOracle.value.toHexString();
  }

  // set liquidation incentive for pool entity
  let tryLiquidationIncentive = troller.try_liquidationIncentiveMantissa();
  if (tryLiquidationIncentive.reverted) {
    log.warning(
      "[getOrCreateProtocol] liquidationIncentiveMantissaResult reverted",
      []
    );
  } else {
    pool.liquidationIncentive = tryLiquidationIncentive.value
      .toBigDecimal()
      .div(mantissaFactorBD)
      .times(BIGDECIMAL_HUNDRED);
  }
  let poolRegisteredId = event.transaction.hash
    .toHexString()
    .concat("-")
    .concat(event.transactionLogIndex.toString());

  const poolRegistered = new PoolRegistered(poolRegisteredId);

  poolRegistered.hash = event.transaction.hash.toHexString();
  poolRegistered.nonce = event.transaction.nonce;
  poolRegistered.logIndex = event.transactionLogIndex.toI32();
  poolRegistered.blockNumber = event.block.number;
  poolRegistered.timestamp = event.block.timestamp;
  poolRegistered.index = event.params.index;
  poolRegistered.pool = pool.id;

  poolRegistered.save();
  pool.save();
}

//////////////////////////////
//// Comptroller Handlers ////
//////////////////////////////

// Note: these are pool level functions in fuse, but each pool is a Comptroller impl
// Source: https://docs.rari.capital/fuse

// add a new market
export function handleMarketListed(event: MarketListed): void {
  CTokenTemplate.create(event.params.cToken);
  let cTokenContract = CToken.bind(event.params.cToken);
  let comptrollerAddr = cTokenContract.try_comptroller();

  let protocol = getOrCreateProtocol(comptrollerAddr.value);
  if (!protocol) {
    // best effort
    log.warning("[handleMarketListed] Protocol not found: {}", [
      FACTORY_CONTRACT,
    ]);
    return;
  }

  // get/create ctoken

  let cToken = new TokenData(
    event.params.cToken,
    getOrElse(cTokenContract.try_name(), "UNKNOWN"),
    getOrElse(cTokenContract.try_symbol(), "UNKNOWN"),
    getOrElse(cTokenContract.try_decimals(), -1)
  );

  // get/create underlying token
  let underlyingAddress = getOrElse(
    cTokenContract.try_underlying(),
    Address.fromString(ZERO_ADDRESS)
  );

  let underlyingToken: TokenData;
  if (underlyingAddress == Address.fromString(ZERO_ADDRESS)) {
    // this is ETH
    underlyingToken = new TokenData(
      Address.fromString(ETH_ADDRESS),
      ETH_NAME,
      ETH_SYMBOL,
      mantissaFactor
    );
  } else {
    let underlyingContract = ERC20.bind(underlyingAddress);
    underlyingToken = new TokenData(
      underlyingAddress,
      getOrElse(underlyingContract.try_name(), "UNKNOWN"),
      getOrElse(underlyingContract.try_symbol(), "UNKOWN"),
      getOrElse(underlyingContract.try_decimals(), -1)
    );
  }

  // populate market data
  let marketData = new MarketListedData(
    protocol,
    underlyingToken,
    cToken,
    getOrElse(cTokenContract.try_reserveFactorMantissa(), BIGINT_ZERO)
  );

  _handleMarketListed(marketData, event);

  // fuse-specific: add fuseFees and adminFees

  // get fuse fee - rari collects this (ie, protocol revenue)
  let tryFuseFeeMantissa = cTokenContract.try_fuseFeeMantissa();
  updateOrCreateRariFee(
    tryFuseFeeMantissa.reverted ? BIGINT_ZERO : tryFuseFeeMantissa.value,
    RariFee.FUSE_FEE,
    event.params.cToken.toHexString()
  );

  // get admin fee - pool owners (admin) collect this (ie, protocol revenue)
  let tryAdminFeeMantissa = cTokenContract.try_adminFeeMantissa();
  updateOrCreateRariFee(
    tryAdminFeeMantissa.reverted ? BIGINT_ZERO : tryAdminFeeMantissa.value,
    RariFee.ADMIN_FEE,
    event.params.cToken.toHexString()
  );

  // add market ID to the fuse pool
  let pool = _FusePool.load(event.address.toHexString());
  if (!pool) {
    // best effort
    log.warning("[handleMarketListed] FusePool not found: {}", [
      event.address.toHexString(),
    ]);
    return;
  }
  let markets = pool.marketIDs;
  markets.push(event.params.cToken.toHexString());
  pool.marketIDs = markets;
  pool.save();

  // set liquidation incentive (fuse-specific)
  let market = Market.load(event.params.cToken.toHexString())!;
  market.liquidationPenalty = pool.liquidationIncentive;
  market.poolId = pool.id;
  market.save();
}

// update a given markets collateral factor
export function handleNewCollateralFactor(event: NewCollateralFactor): void {
  let marketID = event.params.cToken.toHexString();
  let newCollateralFactorMantissa = event.params.newCollateralFactorMantissa;
  _handleNewCollateralFactor(marketID, newCollateralFactorMantissa);
}

export function handleNewLiquidationIncentive(
  event: NewLiquidationIncentive
): void {
  let liquidationIncentive = event.params.newLiquidationIncentiveMantissa
    .toBigDecimal()
    .div(mantissaFactorBD)
    .minus(BIGDECIMAL_ONE)
    .times(BIGDECIMAL_HUNDRED);
  let pool = _FusePool.load(event.address.toHexString());
  if (!pool) {
    // best effort
    log.warning("[handleNewLiquidationIncentive] FusePool not found: {}", [
      event.address.toHexString(),
    ]);
    return;
  }
  pool.liquidationIncentive = liquidationIncentive;
  pool.save();

  for (let i = 0; i < pool.marketIDs.length; i++) {
    let market = Market.load(pool.marketIDs[i]);
    if (!market) {
      log.warning("[handleNewLiquidationIncentive] Market not found: {}", [
        pool.marketIDs[i],
      ]);
      // best effort
      continue;
    }
    market.liquidationPenalty = liquidationIncentive;
    market.save();
  }
}

export function handleNewPriceOracle(event: NewPriceOracle): void {
  let pool = _FusePool.load(event.address.toHexString());
  if (!pool) {
    // best effort
    log.warning("[handleNewPriceOracle] FusePool not found: {}", [
      event.address.toHexString(),
    ]);
    return;
  }
  pool.priceOracle = event.params.newPriceOracle.toHexString();
  pool.save();
}

export function handleWhitelistEnforcementChanged(
  event: WhitelistEnforcementChanged
): void {
  let pool = _FusePool.load(event.address.toHexString());
  if (!pool) {
    // best effort
    log.warning("[handleNewPriceOracle] FusePool not found: {}", [
      event.address.toHexString(),
    ]);
    return;
  }
  pool.enforceWhitelist = event.params.enforce;
  pool.save();
}

export function handleActionPaused(event: ActionPaused1): void {
  let marketID = event.params.cToken.toHexString();
  let action = event.params.action;
  let pauseState = event.params.pauseState;
  _handleActionPaused(marketID, action, pauseState);
}

/////////////////////////
//// CToken Handlers ////
/////////////////////////

export function handleMint(event: Mint): void {
  let minter = event.params.minter;
  let mintAmount = event.params.mintAmount;
  let factoryContract = Address.fromString(FACTORY_CONTRACT);

  let cTokenContract = CToken.bind(event.address);
  let underlyingBalanceResult = cTokenContract.try_balanceOfUnderlying(
    event.params.minter
  );
  _handleMint(
    factoryContract,
    minter,
    mintAmount,
    underlyingBalanceResult,
    event
  );
}

export function handleRedeem(event: Redeem): void {
  let redeemer = event.params.redeemer;
  let redeemAmount = event.params.redeemAmount;
  let factoryContract = Address.fromString(FACTORY_CONTRACT);

  let cTokenContract = CToken.bind(event.address);
  let underlyingBalanceResult = cTokenContract.try_balanceOfUnderlying(
    event.params.redeemer
  );
  _handleRedeem(
    factoryContract,
    redeemer,
    redeemAmount,
    underlyingBalanceResult,
    event
  );
}

export function handleBorrow(event: Borrow): void {
  let borrower = event.params.borrower;
  let borrowAmount = event.params.borrowAmount;
  let factoryContract = Address.fromString(FACTORY_CONTRACT);

  let cTokenContract = CToken.bind(event.address);
  let borrowBalanceResult = cTokenContract.try_borrowBalanceCurrent(
    event.params.borrower
  );
  _handleBorrow(
    factoryContract,
    borrower,
    borrowAmount,
    borrowBalanceResult,
    event
  );
}

export function handleRepayBorrow(event: RepayBorrow): void {
  let payer = event.params.payer;
  let repayAmount = event.params.repayAmount;
  let factoryContract = Address.fromString(FACTORY_CONTRACT);

  let cTokenContract = CToken.bind(event.address);
  let borrowBalanceResult = cTokenContract.try_borrowBalanceCurrent(
    event.params.borrower
  );
  _handleRepayBorrow(
    factoryContract,
    event.params.borrower,
    payer,
    repayAmount,
    borrowBalanceResult,
    event
  );
}

export function handleLiquidateBorrow(event: LiquidateBorrow): void {
  let cTokenCollateral = event.params.cTokenCollateral;
  let liquidator = event.params.liquidator;
  let borrower = event.params.borrower;
  let seizeTokens = event.params.seizeTokens;
  let repayAmount = event.params.repayAmount;
  let factoryContract = Address.fromString(FACTORY_CONTRACT);

  _handleLiquidateBorrow(
    factoryContract,
    cTokenCollateral,
    liquidator,
    borrower,
    seizeTokens,
    repayAmount,
    event
  );
}

export function handleAccrueInterest(event: AccrueInterest): void {
  let marketAddress = event.address;
  // get comptroller address
  let trollerAddr: Address;
  if (
    (trollerAddr = getComptrollerAddress(event)) ==
    Address.fromString(ZERO_ADDRESS)
  ) {
    log.warning("[handleAccrueInterest] Comptroller address not found.", []);
    return;
  }

  let cTokenContract = CToken.bind(marketAddress);
  let pool = _FusePool.load(trollerAddr.toHexString());
  if (!pool) {
    // best effort
    log.warning("[handleAccrueInterest] FusePool not found: {}", [
      trollerAddr.toHexString(),
    ]);
    return;
  }
  let oracleContract = PriceOracle.bind(Address.fromString(pool.priceOracle));

  // get rolling blocks/day count
  getRewardsPerDay(
    event.block.timestamp,
    event.block.number,
    BIGDECIMAL_ZERO,
    RewardIntervalType.BLOCK
  );
  let blocksPerDayBD = getOrCreateCircularBuffer().blocksPerDay;
  let blocksPerDayBI = BigInt.fromString(blocksPerDayBD.truncate(0).toString());
  let blocksPerYear: i32;
  if (blocksPerDayBI.isI32()) {
    blocksPerYear = blocksPerDayBI.toI32() * DAYS_PER_YEAR;
  } else {
    blocksPerYear = ETHEREUM_BLOCKS_PER_YEAR;
  }

  //
  // replacing _handleAccrueInterest() to properly derive assetPrice
  //

  let marketID = event.address.toHexString();
  let market = Market.load(marketID);
  if (!market) {
    log.warning("[handleAccrueInterest] Market not found: {}", [marketID]);
    return;
  }

  let updateMarketData = new UpdateMarketData(
    cTokenContract.try_totalSupply(),
    cTokenContract.try_exchangeRateStored(),
    cTokenContract.try_supplyRatePerBlock(),
    cTokenContract.try_borrowRatePerBlock(),
    oracleContract.try_getUnderlyingPrice(marketAddress),
    blocksPerYear
  );

  // creates and initializes market snapshots

  //
  // daily snapshot
  //
  getOrCreateMarketDailySnapshot(
    market,
    event.block.timestamp,
    event.block.number
  );

  //
  // hourly snapshot
  //
  getOrCreateMarketHourlySnapshot(
    market,
    event.block.timestamp,
    event.block.number
  );

  // handles fuse and admin fees (ie, protocol-side)
  updateMarket(
    updateMarketData,
    marketID,
    event.params.interestAccumulated,
    event.params.totalBorrows,
    event.block.number,
    event.block.timestamp,
    trollerAddr,
    blocksPerDayBD,
    PROTOCOL_NETWORK == Network.ARBITRUM_ONE ? true : false // update all prices if network is arbitrum
  );
  updateProtocol(Address.fromString(FACTORY_CONTRACT));

  snapshotFinancials(
    Address.fromString(FACTORY_CONTRACT),
    event.block.number,
    event.block.timestamp
  );
}

export function handleNewFuseFee(event: NewFuseFee): void {
  updateOrCreateRariFee(
    event.params.newFuseFeeMantissa,
    RariFee.FUSE_FEE,
    event.address.toHexString()
  );
}

export function handleNewAdminFee(event: NewAdminFee): void {
  updateOrCreateRariFee(
    event.params.newAdminFeeMantissa,
    RariFee.ADMIN_FEE,
    event.address.toHexString()
  );
}

export function handleNewReserveFactor(event: NewReserveFactor): void {
  let marketID = event.address.toHexString();
  let newReserveFactorMantissa = event.params.newReserveFactorMantissa;
  _handleNewReserveFactor(marketID, newReserveFactorMantissa);
}

/////////////////
//// Helpers ////
/////////////////

function getComptrollerAddress(event: ethereum.Event): Address {
  let cTokenContract = CToken.bind(event.address);
  let tryComptroller = cTokenContract.try_comptroller();

  if (tryComptroller.reverted) {
    // comptroller does not exist
    log.warning(
      "[handleTransaction] Comptroller not found for transaction: {}",
      [event.transaction.hash.toHexString()]
    );
    return Address.fromString(ZERO_ADDRESS);
  }

  return tryComptroller.value;
}

// updates the rate or creates the rari fee (either fuse or admin fee)
function updateOrCreateRariFee(
  rateMantissa: BigInt,
  rariFeeType: string,
  marketID: string
): void {
  let rariFeeId =
    InterestRateSide.BORROWER + "-" + rariFeeType + "-" + marketID;
  let rariFee = InterestRate.load(rariFeeId);

  // calculate fee rate
  let rate = rateMantissa
    .toBigDecimal()
    .div(mantissaFactorBD)
    .times(BIGDECIMAL_HUNDRED);

  if (!rariFee) {
    rariFee = new InterestRate(rariFeeId);
    rariFee.side = InterestRateSide.BORROWER;
    rariFee.type = InterestRateType.STABLE;

    // add to market rates array
    let market = Market.load(marketID);
    if (!market) {
      // best effort
      return;
    }
    let rates = market.rates;
    rates.push(rariFee.id);
    market.rates = rates;
    market.save();
  }

  rariFee.rate = rate;
  rariFee.save();
}

// this function will "override" the updateMarket() function in ../../src/mapping.ts
// this function accounts for price oracles returning price in ETH in fuse
// this function calculates revenues with admin and fuse fees as well (fuse-specific)
function updateMarket(
  updateMarketData: UpdateMarketData,
  marketID: string,
  interestAccumulatedMantissa: BigInt,
  newTotalBorrow: BigInt,
  blockNumber: BigInt,
  blockTimestamp: BigInt,
  comptroller: Address,
  blocksPerDay: BigDecimal,
  updateMarketPrices: boolean
): void {
  let market = Market.load(marketID);
  if (!market) {
    log.warning("[updateMarket] Market not found: {}", [marketID]);
    return;
  }

  let underlyingToken = Token.load(market.inputToken);
  if (!underlyingToken) {
    log.warning("[updateMarket] Underlying token not found: {}", [
      market.inputToken,
    ]);
    return;
  }

  let pool = _FusePool.load(market.poolId!);
  if (!pool) {
    log.warning("[updateMarket] Pool not found: {}", [market.poolId!]);
    return;
  }

  if (updateMarketPrices) {
    updateAllMarketPrices(comptroller, blockNumber);
  }

  // update this market's price no matter what
  // grab price of ETH then multiply by underlying pric
  let comptollerContract = MarketComptroller.bind(comptroller);
  let oracleResult = comptollerContract.try_oracle();

  if (oracleResult.reverted) {
    throw new Error("Could not get oracle from comptroller");
  }
  let oracle = oracleResult.value;

  let customETHPrice = getUsdPricePerToken(
    Address.fromString(ETH_ADDRESS),
    oracle
  );
  let ethPriceUSD = customETHPrice.usdPrice.div(customETHPrice.decimalsBaseTen);

  let underlyingTokenPriceUSD: BigDecimal;
  if (updateMarketData.getUnderlyingPriceResult.reverted) {
    log.warning("[updateMarket] Underlying price not found for market: {}", [
      marketID,
    ]);
    let backupPrice = getUsdPricePerToken(
      Address.fromString(market.inputToken),
      oracle
    );
    underlyingTokenPriceUSD = backupPrice.usdPrice.div(
      backupPrice.decimalsBaseTen
    );
  } else {
    let mantissaDecimalFactor = 18 - underlyingToken.decimals + 18;
    let bdFactor = exponentToBigDecimal(mantissaDecimalFactor);
    let priceInEth = updateMarketData.getUnderlyingPriceResult.value
      .toBigDecimal()
      .div(bdFactor);
    underlyingTokenPriceUSD = priceInEth.times(ethPriceUSD); // get price in USD

    log.debug(
      `Line 658, ETH price: ${ethPriceUSD}, Underlying Price: ${updateMarketData.getUnderlyingPriceResult.value}, Underlying Price USD: ${underlyingTokenPriceUSD}`,
      []
    );
  }

  underlyingToken.lastPriceUSD = underlyingTokenPriceUSD;
  underlyingToken.lastPriceBlockNumber = blockNumber;
  underlyingToken.save();

  market.inputTokenPriceUSD = underlyingTokenPriceUSD;

  if (updateMarketData.totalSupplyResult.reverted) {
    log.warning("[updateMarket] Failed to get totalSupply of Market {}", [
      marketID,
    ]);
  } else {
    market.outputTokenSupply = updateMarketData.totalSupplyResult.value;
  }

  // get correct outputTokenDecimals for generic exchangeRate calculation
  let outputTokenDecimals = cTokenDecimals;
  if (market.outputToken) {
    let outputToken = Token.load(market.outputToken!);
    if (!outputToken) {
      log.warning("[updateMarket] Output token not found: {}", [
        market.outputToken!,
      ]);
    } else {
      outputTokenDecimals = outputToken.decimals;
    }
  }

  if (updateMarketData.exchangeRateStoredResult.reverted) {
    log.warning(
      "[updateMarket] Failed to get exchangeRateStored of Market {}",
      [marketID]
    );
  } else {
    // Formula: check out "Interpreting Exchange Rates" in https://compound.finance/docs#protocol-math
    let oneCTokenInUnderlying = updateMarketData.exchangeRateStoredResult.value
      .toBigDecimal()
      .div(
        exponentToBigDecimal(
          mantissaFactor + underlyingToken.decimals - outputTokenDecimals
        )
      );
    market.exchangeRate = oneCTokenInUnderlying;
    market.outputTokenPriceUSD = oneCTokenInUnderlying.times(
      underlyingTokenPriceUSD
    );

    // calculate inputTokenBalance only if exchangeRate is updated properly
    // mantissaFactor = (inputTokenDecimals - outputTokenDecimals)  (Note: can be negative)
    // inputTokenBalance = (outputSupply * exchangeRate) * (10 ^ mantissaFactor)
    if (underlyingToken.decimals > outputTokenDecimals) {
      // we want to multiply out the difference to expand BD
      let mantissaFactorBD = exponentToBigDecimal(
        underlyingToken.decimals - outputTokenDecimals
      );
      let inputTokenBalanceBD = market.outputTokenSupply
        .toBigDecimal()
        .times(market.exchangeRate!)
        .times(mantissaFactorBD)
        .truncate(0);
      market.inputTokenBalance = BigInt.fromString(
        inputTokenBalanceBD.toString()
      );
    } else {
      // we want to divide back the difference to decrease the BD
      let mantissaFactorBD = exponentToBigDecimal(
        outputTokenDecimals - underlyingToken.decimals
      );
      let inputTokenBalanceBD = market.outputTokenSupply
        .toBigDecimal()
        .times(market.exchangeRate!)
        .div(mantissaFactorBD)
        .truncate(0);
      market.inputTokenBalance = BigInt.fromString(
        inputTokenBalanceBD.toString()
      );
    }
  }

  let underlyingSupplyUSD = market.inputTokenBalance
    .toBigDecimal()
    .div(exponentToBigDecimal(underlyingToken.decimals))
    .times(underlyingTokenPriceUSD);

  pool.totalDepositBalanceUSD =
    pool.totalDepositBalanceUSD.plus(underlyingSupplyUSD);
  pool.totalValueLockedUSD = pool.totalValueLockedUSD.plus(underlyingSupplyUSD);

  pool.totalBorrowBalanceUSD = pool.totalBorrowBalanceUSD.plus(
    newTotalBorrow
      .toBigDecimal()
      .div(exponentToBigDecimal(underlyingToken.decimals))
      .times(underlyingTokenPriceUSD)
  );

  pool.totalDepositBalanceUSD = pool.totalDepositBalanceUSD.minus(
    market.totalDepositBalanceUSD
  );
  pool.totalValueLockedUSD = pool.totalValueLockedUSD.minus(
    market.totalValueLockedUSD
  );
  pool.totalBorrowBalanceUSD = pool.totalBorrowBalanceUSD.minus(
    market.totalBorrowBalanceUSD
  );

  market.totalValueLockedUSD = underlyingSupplyUSD;
  market.totalDepositBalanceUSD = underlyingSupplyUSD;

  market.totalBorrowBalanceUSD = newTotalBorrow
    .toBigDecimal()
    .div(exponentToBigDecimal(underlyingToken.decimals))
    .times(underlyingTokenPriceUSD);

  if (updateMarketData.supplyRateResult.reverted) {
    log.warning("[updateMarket] Failed to get supplyRate of Market {}", [
      marketID,
    ]);
  } else {
    setSupplyInterestRate(
      marketID,
      convertRatePerUnitToAPY(
        updateMarketData.supplyRateResult.value,
        updateMarketData.unitPerYear
      )
    );
  }

  if (updateMarketData.borrowRateResult.reverted) {
    log.warning("[updateMarket] Failed to get borrowRate of Market {}", [
      marketID,
    ]);
  } else {
    setBorrowInterestRate(
      marketID,
      convertRatePerUnitToAPY(
        updateMarketData.borrowRateResult.value,
        updateMarketData.unitPerYear
      )
    );
  }

  // update rewards
  // let troller = MarketComptroller.bind(comptroller);
  // let tryRewardDistributors = troller.try_getRewardsDistributors();
  // if (!tryRewardDistributors.reverted) {
  //   let rewardDistributors = tryRewardDistributors.value;
  //   updateRewards(rewardDistributors, marketID, blocksPerDay, blockNumber);
  // }

  // calculate new interests accumulated
  // With fuse protocol revenue includes (reserve factor + fuse fee + admin fee)
  let fuseFeeId =
    InterestRateSide.BORROWER + "-" + RariFee.FUSE_FEE + "-" + marketID;
  let fuseFee = InterestRate.load(fuseFeeId)!.rate.div(
    exponentToBigDecimal(INT_TWO)
  );

  let adminFeeId =
    InterestRateSide.BORROWER + "-" + RariFee.ADMIN_FEE + "-" + marketID;
  let adminFee = InterestRate.load(adminFeeId)!.rate.div(
    exponentToBigDecimal(INT_TWO)
  );

  let interestAccumulatedUSD = interestAccumulatedMantissa
    .toBigDecimal()
    .div(exponentToBigDecimal(underlyingToken.decimals))
    .times(underlyingTokenPriceUSD);

  let protocolSideRevenueUSDDelta = interestAccumulatedUSD.times(
    market._reserveFactor.plus(fuseFee).plus(adminFee)
  );
  let supplySideRevenueUSDDelta = interestAccumulatedUSD.minus(
    protocolSideRevenueUSDDelta
  );

  market.cumulativeTotalRevenueUSD = market.cumulativeTotalRevenueUSD.plus(
    interestAccumulatedUSD
  );
  market.cumulativeProtocolSideRevenueUSD =
    market.cumulativeProtocolSideRevenueUSD.plus(protocolSideRevenueUSDDelta);
  market.cumulativeSupplySideRevenueUSD =
    market.cumulativeSupplySideRevenueUSD.plus(supplySideRevenueUSDDelta);

  market.save();
  pool.save();

  // update daily fields in marketDailySnapshot
  let dailySnapshot = getOrCreateMarketDailySnapshot(
    market,
    blockTimestamp,
    blockNumber
  );
  dailySnapshot.dailyTotalRevenueUSD = dailySnapshot.dailyTotalRevenueUSD.plus(
    interestAccumulatedUSD
  );
  dailySnapshot.dailyProtocolSideRevenueUSD =
    dailySnapshot.dailyProtocolSideRevenueUSD.plus(protocolSideRevenueUSDDelta);
  dailySnapshot.dailySupplySideRevenueUSD =
    dailySnapshot.dailySupplySideRevenueUSD.plus(supplySideRevenueUSDDelta);
  dailySnapshot.save();

  // update hourly fields in marketHourlySnapshot
  let hourlySnapshot = getOrCreateMarketHourlySnapshot(
    market,
    blockTimestamp,
    blockNumber
  );
  hourlySnapshot.hourlyTotalRevenueUSD =
    hourlySnapshot.hourlyTotalRevenueUSD.plus(interestAccumulatedUSD);
  hourlySnapshot.hourlyProtocolSideRevenueUSD =
    hourlySnapshot.hourlyProtocolSideRevenueUSD.plus(
      protocolSideRevenueUSDDelta
    );
  hourlySnapshot.hourlySupplySideRevenueUSD =
    hourlySnapshot.hourlySupplySideRevenueUSD.plus(supplySideRevenueUSDDelta);
  hourlySnapshot.save();
}

function updateRewards(
  rewardDistributor: Address[],
  marketID: string,
  blocksPerDay: BigDecimal,
  blockNumber: BigInt
): void {}

function updateAllMarketPrices(
  comptrollerAddr: Address,
  blockNumber: BigInt
): void {
  let protocol = getOrCreateProtocol(comptrollerAddr);
  if (!protocol) {
    log.warning("[updateAllMarketPrices] protocol not found: {}", [
      comptrollerAddr.toHexString(),
    ]);
    return;
  }
  let oracleAddr = Address.fromString(protocol._priceOracle);
  let priceOracle = PriceOracle.bind(oracleAddr);

  for (let i = 0; i < protocol._marketIDs.length; i++) {
    let market = Market.load(protocol._marketIDs[i]);
    if (!market) {
      break;
    }
    let underlyingToken = Token.load(market.inputToken);
    if (!underlyingToken) {
      break;
    }
    let pool = _FusePool.load(market.poolId!);
    if (!pool) {
      break;
    }

    // update market price
    let customETHPrice = getUsdPricePerToken(
      Address.fromString(ETH_ADDRESS),
      oracleAddr
    );
    let ethPriceUSD = customETHPrice.usdPrice.div(
      customETHPrice.decimalsBaseTen
    );
    let tryUnderlyingPrice = priceOracle.try_getUnderlyingPrice(
      Address.fromString(market.id)
    );

    let underlyingTokenPriceUSD: BigDecimal;
    if (tryUnderlyingPrice.reverted) {
      log.warning("[updateMarket] Underlying price not found for market: {}", [
        market.id,
      ]);
      let backupPrice = getUsdPricePerToken(
        Address.fromString(market.inputToken),
        MarketComptroller.bind(comptrollerAddr).try_oracle().value
      );
      underlyingTokenPriceUSD = backupPrice.usdPrice.div(
        backupPrice.decimalsBaseTen
      );
    } else {
      let mantissaDecimalFactor = 18 - underlyingToken.decimals + 18;
      let bdFactor = exponentToBigDecimal(mantissaDecimalFactor);
      let priceInEth = tryUnderlyingPrice.value.toBigDecimal().div(bdFactor);
      underlyingTokenPriceUSD = priceInEth.times(ethPriceUSD); // get price in USD
    }

    let lastPriceUSD = underlyingTokenPriceUSD;

    underlyingToken.lastPriceUSD = underlyingTokenPriceUSD;
    underlyingToken.lastPriceBlockNumber = blockNumber;
    underlyingToken.save();

    market.inputTokenPriceUSD = underlyingTokenPriceUSD;

    pool.totalDepositBalanceUSD = pool.totalDepositBalanceUSD.minus(
      market.totalValueLockedUSD
    );
    pool.totalValueLockedUSD = pool.totalValueLockedUSD.minus(
      market.totalDepositBalanceUSD
    );
    pool.totalBorrowBalanceUSD = pool.totalValueLockedUSD.minus(
      market.totalBorrowBalanceUSD
    );

    // update TVL, supplyUSD, borrowUSD
    market.totalDepositBalanceUSD = market.inputTokenBalance
      .toBigDecimal()
      .div(exponentToBigDecimal(underlyingToken.decimals))
      .times(underlyingTokenPriceUSD);
    market.totalBorrowBalanceUSD = market.totalBorrowBalanceUSD
      .div(lastPriceUSD)
      .times(underlyingTokenPriceUSD);
    market.totalValueLockedUSD = market.inputTokenBalance
      .toBigDecimal()
      .div(exponentToBigDecimal(underlyingToken.decimals))
      .times(underlyingTokenPriceUSD);

    pool.totalDepositBalanceUSD = pool.totalDepositBalanceUSD.plus(
      market.totalValueLockedUSD
    );
    pool.totalValueLockedUSD = pool.totalValueLockedUSD.plus(
      market.totalDepositBalanceUSD
    );
    pool.totalBorrowBalanceUSD = pool.totalValueLockedUSD.plus(
      market.totalBorrowBalanceUSD
    );

    pool.save();
    market.save();
  }
}

function getOrCreateProtocol(comptrollerAddr: Address): LendingProtocol {
  let comptroller = Comptroller.bind(comptrollerAddr);
  let protocolData = new ProtocolData(
    comptrollerAddr,
    PROTOCOL_NAME,
    PROTOCOL_SLUG,
    SCHEMA_VERSION,
    SUBGRAPH_VERSION,
    METHODOLOGY_VERSION,
    PROTOCOL_NETWORK,
    comptroller.try_liquidationIncentiveMantissa(),
    comptroller.try_oracle()
  );

  return _getOrCreateProtocol(protocolData);
}
