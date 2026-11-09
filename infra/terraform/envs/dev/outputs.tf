output "resource_group" { value = azurerm_resource_group.this.name }
output "acr_login_server" { value = module.acr.login_server }
output "container_app_environment_id" { value = module.container_apps.environment_id }
output "app_fqdns" { value = module.container_apps.app_fqdns }
output "key_vault_uri" { value = module.keyvault.key_vault_uri }
output "servicebus_endpoint" { value = module.servicebus.namespace_endpoint }
output "blob_endpoint" { value = module.blob.primary_blob_endpoint }

output "fabric_workspace_id" { value = module.fabric_sqldb.workspace_id }
output "fabric_sql_database_id" { value = module.fabric_sqldb.sql_database_id }

output "doc_intelligence_endpoint" { value = module.ai.doc_intelligence_endpoint }
output "openai_endpoint" { value = module.ai.openai_endpoint }
output "openai_deployment_name" { value = module.ai.openai_deployment_name }

output "managed_identity_client_ids" { value = module.identity.client_ids }
