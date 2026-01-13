-- PostgreSQL Database Setup for Pinning Service
-- Run this first to create the database and user
--
-- Run as superuser: sudo -u postgres psql -f 000_setup.sql

-- Create database (run separately if it doesn't exist)
-- CREATE DATABASE pinning_service;

-- Create application user with password
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pinning_user') THEN
        CREATE USER pinning_user WITH PASSWORD 'CHANGE_ME_IN_PRODUCTION';
    END IF;
END
$$;

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE pinning_service TO pinning_user;

-- Connect to the database and set up schema permissions
\c pinning_service

-- Grant schema permissions
GRANT ALL ON SCHEMA public TO pinning_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO pinning_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO pinning_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO pinning_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO pinning_user;

-- ============================================
-- PostgreSQL Performance Settings (Recommendations)
-- Add these to postgresql.conf for production
-- ============================================
--
-- # Connection Settings
-- max_connections = 150                  # Allow 100 for apps + 50 reserved
--
-- # Memory Settings (adjust based on available RAM)
-- shared_buffers = 256MB                 # 25% of RAM, min 128MB
-- effective_cache_size = 768MB           # 75% of RAM
-- work_mem = 16MB                        # Per-operation memory
-- maintenance_work_mem = 128MB           # For VACUUM, CREATE INDEX
--
-- # WAL Settings
-- wal_buffers = 16MB
-- checkpoint_completion_target = 0.9
--
-- # Query Planner
-- random_page_cost = 1.1                 # For SSD storage
-- effective_io_concurrency = 200         # For SSD storage
--
-- # Logging (optional, for debugging)
-- log_statement = 'none'                 # Change to 'all' for debugging
-- log_duration = off
-- log_min_duration_statement = 1000      # Log queries over 1 second
