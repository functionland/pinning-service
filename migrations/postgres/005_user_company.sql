-- Migration: Add company field to webui_users
-- Company is pre-filled from referral link name when user signs up
--
-- Run with: psql -d pinning_service -f 005_user_company.sql

-- Add company column to webui_users
ALTER TABLE webui_users
    ADD COLUMN IF NOT EXISTS company TEXT DEFAULT NULL;
