import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from fish_watchdog import decide, next_cooldown, parse_hold_until

NOW = datetime(2026, 11, 4, 12, 0, 0, tzinfo=timezone.utc)
FRESH = NOW - timedelta(seconds=30)
STALE = NOW - timedelta(seconds=121)
ON = {"enabled": True, "watch": True}


class DecideTest(unittest.TestCase):
    def test_healthy(self):
        d = decide(now=NOW, policy=ON, health_at=FRESH, host_state="active",
                   xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "ok")

    def test_host_activating_waits(self):
        d = decide(now=NOW, policy=ON, health_at=FRESH, host_state="activating",
                   xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "wait")

    def test_host_starting_waits(self):
        d = decide(now=NOW, policy=ON, health_at=STALE, host_state="active",
                   xvfb_state="active", wechat_state="active", host_uptime_sec=30)
        self.assertEqual(d.action, "wait")

    def test_host_inactive_restarts_even_with_watch_off(self):
        d = decide(now=NOW, policy={"enabled": False, "watch": False}, health_at=None,
                   host_state="failed", xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "restart-host")

    def test_watch_off_ignores_stale_health(self):
        d = decide(now=NOW, policy={"enabled": True, "watch": False}, health_at=STALE,
                   host_state="active", xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "ok")

    def test_policy_disabled_ignores_stale_health(self):
        d = decide(now=NOW, policy={"enabled": False}, health_at=STALE,
                   host_state="active", xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "ok")

    def test_stale_health_with_dead_wechat_starts_deps(self):
        d = decide(now=NOW, policy=ON, health_at=STALE, host_state="active",
                   xvfb_state="active", wechat_state="inactive")
        self.assertEqual(d.action, "start-deps")

    def test_stale_health_with_dead_xvfb_starts_deps(self):
        d = decide(now=NOW, policy=ON, health_at=None, host_state="active",
                   xvfb_state="inactive", wechat_state="active")
        self.assertEqual(d.action, "start-deps")

    def test_stale_health_with_deps_up_restarts_host(self):
        d = decide(now=NOW, policy=ON, health_at=STALE, host_state="active",
                   xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "restart-host")

    def test_missing_health_with_deps_up_restarts_host(self):
        d = decide(now=NOW, policy=ON, health_at=None, host_state="active",
                   xvfb_state="active", wechat_state="active")
        self.assertEqual(d.action, "restart-host")

    def test_cooldown_backoff(self):
        self.assertEqual(next_cooldown(0), 600)
        self.assertEqual(next_cooldown(2), 600)
        self.assertEqual(next_cooldown(3), 1800)
        self.assertEqual(next_cooldown(9), 1800)

    def test_hold_defers_restart_when_host_down(self):
        d = decide(now=NOW, policy=ON, health_at=None, host_state="failed",
                   xvfb_state="active", wechat_state="active",
                   hold_until=NOW + timedelta(minutes=5))
        self.assertEqual(d.action, "wait")
        self.assertEqual(d.reason, "hold")

    def test_hold_defers_restart_when_host_unresponsive(self):
        d = decide(now=NOW, policy=ON, health_at=STALE, host_state="unhealthy",
                   xvfb_state="active", wechat_state="active",
                   hold_until=NOW + timedelta(minutes=5))
        self.assertEqual(d.action, "wait")
        self.assertEqual(d.reason, "hold")

    def test_expired_hold_restarts(self):
        d = decide(now=NOW, policy=ON, health_at=None, host_state="failed",
                   xvfb_state="active", wechat_state="active",
                   hold_until=NOW - timedelta(seconds=1))
        self.assertEqual(d.action, "restart-host")

    def test_hold_does_not_affect_healthy_host(self):
        d = decide(now=NOW, policy=ON, health_at=FRESH, host_state="active",
                   xvfb_state="active", wechat_state="active",
                   hold_until=NOW + timedelta(minutes=5))
        self.assertEqual(d.action, "ok")


class HoldParseTest(unittest.TestCase):
    def test_epoch_seconds(self):
        self.assertEqual(parse_hold_until({"until": int(NOW.timestamp())}), NOW)

    def test_epoch_milliseconds(self):
        self.assertEqual(parse_hold_until({"until": int(NOW.timestamp() * 1000)}), NOW)

    def test_iso_z(self):
        self.assertEqual(parse_hold_until({"until": "2026-11-04T12:00:00Z"}), NOW)

    def test_invalid_is_ignored(self):
        self.assertIsNone(parse_hold_until(None))
        self.assertIsNone(parse_hold_until({}))
        self.assertIsNone(parse_hold_until({"until": True}))
        self.assertIsNone(parse_hold_until({"until": "not-a-date"}))
        self.assertIsNone(parse_hold_until({"until": float("inf")}))


if __name__ == "__main__":
    unittest.main()
