-- Rename model_use_behaviors -> model_services
ALTER TABLE model_use_behaviors RENAME TO model_services;

-- Rename indexes
DROP INDEX IF EXISTS mub_name_idx;
CREATE UNIQUE INDEX service_name_idx ON model_services (name);

-- Rename mub_id -> service_id in request_logs
ALTER TABLE request_logs RENAME COLUMN mub_id TO service_id;
ALTER TABLE request_logs RENAME COLUMN mub_name TO service_name;

-- Rename indexes on request_logs
DROP INDEX IF EXISTS request_logs_mub_idx;
CREATE INDEX request_logs_service_idx ON request_logs (service_id);

-- Rename scope_mubs_json -> scope_services_json in tokens
ALTER TABLE tokens RENAME COLUMN scope_mubs_json TO scope_services_json;