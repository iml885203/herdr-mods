"""Tests for mods/claude-goal/goal.sh with a fake `claude`. Run from claude-goal/:

    python3 -I -m unittest discover -s test
"""
import json
import os
import shutil
import stat
import subprocess
import tempfile
import time
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mods", "claude-goal", "goal.sh")


class GoalSh(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, True)
        proj = os.path.join(self.home, ".claude", "projects", "p")
        os.makedirs(proj)
        self.transcript = os.path.join(proj, "sid1.jsonl")
        self.bin = os.path.join(self.home, "bin")
        os.makedirs(self.bin)

    def fake_claude(self, body):
        p = os.path.join(self.bin, "claude")
        with open(p, "w") as f:
            f.write("#!/bin/sh\n" + body)
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)

    def write_transcript(self, texts):
        with open(self.transcript, "w") as f:
            for i, t in enumerate(texts):
                f.write(json.dumps({"type": "user" if i % 2 == 0 else "assistant", "message": {"content": t}}, ensure_ascii=False) + "\n")

    def run_goal(self, **env):
        e = {**os.environ, "HOME": self.home, "PATH": self.bin + ":" + os.environ["PATH"], **env}
        t = time.time()
        r = subprocess.run(["sh", SCRIPT, "sid1"], env=e, capture_output=True, timeout=30)
        return r, time.time() - t

    def test_goal_extracted(self):
        self.write_transcript(["hello"])
        self.fake_claude('cat > /dev/null; echo "<goal>ship it</goal>"\n')
        r, _ = self.run_goal()
        self.assertEqual((r.returncode, r.stdout.decode().strip()), (0, "ship it"))

    def test_tail_cut_never_splits_a_utf8_character(self):
        # 3-byte characters: whatever byte offset tail -c 14000 lands on, the output must stay valid UTF-8.
        for pad in range(3):
            self.write_transcript(["x" * pad + "部署" * 6000])
            self.fake_claude('cat > "$HOME/seen.txt"; echo "<goal>ok</goal>"\n')
            r, _ = self.run_goal()
            self.assertEqual(r.returncode, 0, r.stderr)
            data = open(os.path.join(self.home, "seen.txt"), "rb").read()
            data.decode("utf-8")  # raises on a split character

    def test_hung_claude_is_killed(self):
        self.write_transcript(["hello"])
        self.fake_claude("exec sleep 30\n")
        r, took = self.run_goal(GOAL_TIMEOUT="1")
        self.assertEqual(r.returncode, 142)  # main.js maps this to "took too long"
        self.assertLess(took, 10)


if __name__ == "__main__":
    unittest.main()
