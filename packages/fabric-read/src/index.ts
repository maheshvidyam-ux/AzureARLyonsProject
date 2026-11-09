export * from "./ports.js";
export { InMemoryMasterDataReader, type InMemoryMasterDataOptions } from "./in-memory-reader.js";
export {
  FabricLakehouseMasterDataReader,
  createFabricLakehouseReader,
  lakehouseConfigFromEnv,
  mapCustomerRow,
  mapItemRow,
  DEFAULT_LAKEHOUSE_CONFIG,
  type LakehouseMasterConfig,
  type CustomerColumns,
  type ItemColumns,
} from "./fabric-lakehouse-reader.js";
