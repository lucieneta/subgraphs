import { Address, BigInt } from "@graphprotocol/graph-ts";
import { CustomPriceType } from "../common/types";
import { MasterPriceOracle } from "../../../../../generated/templates/CToken/MasterPriceOracle";
import { MASTER_ORACLE_V2, USDC_ADDR } from "../config/polygon";
import { getTokenDecimals } from "../common/utils";

export function getTokenPriceFromMasterOracle(
  tokenAddr: Address,
  oracle: Address
): CustomPriceType {
  const masterOracle = MasterPriceOracle.bind(oracle);

  let usdcPriceInEth = masterOracle.try_price(Address.fromString(USDC_ADDR));
  let tokenPriceInEth = masterOracle.try_price(tokenAddr);
  let decimals = getTokenDecimals(tokenAddr);

  if (tokenPriceInEth.reverted) {
    throw new Error(`Could not find price for ${tokenAddr}`);
  }
  if (usdcPriceInEth.reverted) {
    throw new Error(`Could not find price for USDC`);
  }
  let tokenPriceUsd = tokenPriceInEth.value
    .toBigDecimal()
    .div(usdcPriceInEth.value.toBigDecimal())
    .times(
      BigInt.fromI32(10)
        .pow(decimals.toU32() as u8)
        .toBigDecimal()
    );

  return CustomPriceType.initialize(tokenPriceUsd, decimals.toI32());
}
