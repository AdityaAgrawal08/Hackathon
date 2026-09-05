-- Migration 0025: Idempotency & Constraint Hardening (FIX-023, FIX-024)
CREATE INDEX IF NOT EXISTS idx_liveevt_rzp_payment_id ON live_payment_events(razorpay_payment_id);
CREATE INDEX IF NOT EXISTS idx_liveevt_order_status ON live_payment_events(razorpay_order_id, status);
CREATE INDEX IF NOT EXISTS idx_so_cust_channel ON scheduled_outreach(customer_profile_id, channel, executed);
