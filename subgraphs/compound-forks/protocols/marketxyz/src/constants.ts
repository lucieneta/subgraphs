import { dataSource } from "@graphprotocol/graph-ts";
import { Network } from "../../../src/constants";

/////////////////////////
//// Network Config  ////
/////////////////////////

export class NetworkSpecificConstant {
  poolDirectoryAddress: string;
  ethAddress: string;
  usdcAddress: string;
  network: string;

  constructor(
    poolDirectoryAddress: string,
    ethAddress: string,
    usdcAddress: string,
    network: string,
  ){
    this.poolDirectoryAddress = poolDirectoryAddress;
    this.ethAddress = ethAddress;
    this.usdcAddress = usdcAddress;
    this.network = network
  }
}

export function getNetworkSpecificConstant(): NetworkSpecificConstant {
  const network = dataSource.network();

  if(equalsIgnoreCase(network, Network.AVALANCHE)){
    return new NetworkSpecificConstant(
      "0x1c4D63bDA492d69f2D6b02Fb622fb6c49cc401d2",
      "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB",
      "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664",
      Network.AVALANCHE
    );
  } else if(equalsIgnoreCase(network, Network.MATIC)){
    return new NetworkSpecificConstant(
      "0xA2a1cb88D86A939A37770FE5E9530E8700DEe56b",
      "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
      Network.MATIC
    );
  } else if(equalsIgnoreCase(network, Network.FANTOM)){
    return new NetworkSpecificConstant(
      "0x0E7d754A8d1a82220432148C10715497a0569BD7",
      "0x74b23882a30290451A17c44f4F05243b6b58C76d",
      "0x04068DA6C83AFCFA0e13ba15A6696662335D5B75",
      Network.FANTOM
    );
  }
  throw new Error(`Unsupported network ${network}`);
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.replace("-", "_").toLowerCase() == b.replace("-", "_").toLowerCase();
}

////////////////////////////
//// Ethereum Addresses ////
////////////////////////////

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const ETH_NAME = "Ether";
export const ETH_SYMBOL = "ETH";

///////////////////////////
//// Protocol Specific ////
///////////////////////////

export const PROTOCOL_NAME = "Market";
export const PROTOCOL_SLUG = "marketxyz";
export const SUBGRAPH_VERSION = "1.0.16";
export const SCHEMA_VERSION = "v1";
export const METHODOLOGY_VERSION = "1.0.0";
