import {BeaconRestApiServerOpts, beaconRestApiServerOpts} from "./rest/index.js";

export type ApiOptions = {
  /** Legacy proof descriptor limit in two-byte units, capped by the response schema. Zero rejects all proofs. */
  maxGindicesInProof?: number;
  rest: BeaconRestApiServerOpts;
  commit?: string;
  version?: string;
  private?: boolean;
};

export const defaultApiOptions: ApiOptions = {
  maxGindicesInProof: 512,
  rest: beaconRestApiServerOpts,
  version: "dev",
  private: false,
};
