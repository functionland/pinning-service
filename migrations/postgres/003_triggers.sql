-- PostgreSQL Triggers for Pinning Service
-- Run after 001_initial_schema.sql and 002_indexes.sql
--
-- Run with: psql -d pinning_service -f 003_triggers.sql

-- ============================================
-- Trigger function for updating updated_at timestamp
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- ============================================
-- Apply triggers to tables with updated_at column
-- ============================================

-- Pins table trigger
DROP TRIGGER IF EXISTS pins_updated_at ON pins;
CREATE TRIGGER pins_updated_at
    BEFORE UPDATE ON pins
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Users table trigger
DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- User credits table trigger
DROP TRIGGER IF EXISTS user_credits_updated_at ON user_credits;
CREATE TRIGGER user_credits_updated_at
    BEFORE UPDATE ON user_credits
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- x402 Gateway Stats table trigger
DROP TRIGGER IF EXISTS x402_gateway_stats_updated_at ON x402_gateway_stats;
CREATE TRIGGER x402_gateway_stats_updated_at
    BEFORE UPDATE ON x402_gateway_stats
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
