#!/bin/bash
set -euo pipefail

mkdir -p migrations
echo 'CREATE TABLE IF NOT EXISTS audit (id bigserial primary key, at timestamptz default now());' > migrations/001.sql
