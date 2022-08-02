import { CustomPriceType } from "./common/types";
import {
  log,
  Address,
  BigDecimal,
  dataSource,
  BigInt,
} from "@graphprotocol/graph-ts";
import { getTokenPriceFromMasterOracle } from "./oracles/MasterPriceOracle";
import { ZERO_ADDRESS } from "../constants";
import { LendingProtocol } from "../../../../generated/schema";

export function getUsdPricePerToken(
  tokenAddr: Address,
  oracle: Address
): CustomPriceType {
  // Check if tokenAddr is a NULL Address
  if (tokenAddr.toHex() == ZERO_ADDRESS) {
    return new CustomPriceType();
  }
  return getTokenPriceFromMasterOracle(tokenAddr, oracle);
}

export function getUsdPrice(
  tokenAddr: Address,
  amount: BigDecimal,
  oracle: Address
): BigDecimal {
  let tokenPrice = getUsdPricePerToken(tokenAddr, oracle);

  if (!tokenPrice.reverted) {
    return tokenPrice.usdPrice.times(amount).div(tokenPrice.decimalsBaseTen);
  }
  return BigInt.fromI32(0).toBigDecimal();
}
