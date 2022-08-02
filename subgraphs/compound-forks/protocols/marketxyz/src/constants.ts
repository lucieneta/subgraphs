// rari fuse v1 constants
import { dataSource } from "@graphprotocol/graph-ts";
import { Network } from "../../../src/constants";

/////////////////////////
//// Network Config  ////
/////////////////////////

export class NetworkSpecificConstant {
  poolDirectoryAddress: string;
  ethPriceOracle: string;
  network: string;
  constructor(
    poolDirectoryAddress: string,
    ethPriceOracle: string,
    network: string
  ) {
    this.poolDirectoryAddress = poolDirectoryAddress;
    this.ethPriceOracle = ethPriceOracle;
    this.network = network;
  }
}

export function getNetworkSpecificConstant(): NetworkSpecificConstant {
  let network = dataSource.network();

  return new NetworkSpecificConstant(
    "0xA2a1cb88D86A939A37770FE5E9530E8700DEe56b",
    "0x71585E806402473Ff25eda3e2C3C17168767858a",
    Network.MATIC
  );
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.replace("-", "_").toLowerCase() == b.replace("-", "_").toLowerCase();
}

////////////////////////////
//// Ethereum Addresses ////
////////////////////////////

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const ETH_ADDRESS = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
export const ETH_NAME = "Ether";
export const ETH_SYMBOL = "ETH";

///////////////////////////
//// Protocol Specific ////
///////////////////////////

export const PROTOCOL_NAME = "Market";
export const PROTOCOL_SLUG = "marketxyz";
export const SUBGRAPH_VERSION = "1.0.16";
export const SCHEMA_VERSION = "1.3.0";
export const METHODOLOGY_VERSION = "1.0.0";
