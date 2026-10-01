#!/usr/bin/env bash
# Runs once, on the first start with an empty data volume (docker-entrypoint-initdb.d), as the superuser
# POSTGRES_USER. Creates the non-superuser application role that owns the app database, plus btree_gist
# (the constraints migration needs it for the slot_no_overlap exclusion constraint; creating it here as
# superuser makes the migration's `CREATE EXTENSION IF NOT EXISTS` a no-op).
set -euo pipefail

: "${APP_DB_NAME:?APP_DB_NAME is required}"
: "${APP_DB_USER:?APP_DB_USER is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_db="$APP_DB_NAME" -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE :"app_user" WITH LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE :"app_db" OWNER :"app_user";
REVOKE ALL ON DATABASE :"app_db" FROM PUBLIC;
\connect :"app_db"
CREATE EXTENSION IF NOT EXISTS btree_gist;
SQL
