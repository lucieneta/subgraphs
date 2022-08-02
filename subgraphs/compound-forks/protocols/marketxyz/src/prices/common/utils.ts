import { _ERC20 } from "../../../../../generated/templates/CToken/_ERC20";
import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";

export function readValue<T>(
  callResult: ethereum.CallResult<T>,
  defaultValue: T
): T {
  return callResult.reverted ? defaultValue : callResult.value;
}

export function getTokenDecimals(tokenAddr: Address): BigInt {
  const token = _ERC20.bind(tokenAddr);

  let decimals = readValue<BigInt>(token.try_decimals(), BigInt.fromI32(18));

  return decimals;
}
