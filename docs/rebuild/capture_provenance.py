"""Capture Git lineage clues, not copyright conclusions. Run from repository root."""
import csv
import hashlib
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parents[2]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=root)


baseline = git("rev-parse", "7972bd6").decode().strip()
head = git("rev-parse", "HEAD").decode().strip()
tracked = git("ls-files", "-z").decode().split("\0")
baseline_paths = set(git("ls-tree", "-r", "--name-only", "-z", baseline).decode().split("\0"))
rows = []
for name in sorted(tracked):
    if not name or not (name.startswith(("apps/desktop/", "packages/", "skills/"))
                        or name in {"package.json", "pnpm-lock.yaml", "LICENSE", "NOTICE"}):
        continue
    path = root / name
    if not path.is_file():
        rows.append([name, "missing-in-working-tree", "", baseline, head, "pending"])
        continue
    content = path.read_bytes()
    lineage = "added-after-port-review-required"
    if name in baseline_paths:
        original = git("show", f"{baseline}:{name}")
        lineage = "port-baseline-identical" if original == content else "port-baseline-modified"
    rows.append([name, lineage, hashlib.sha256(content).hexdigest(), baseline, head, "pending"])

destination = root / "docs/rebuild/LEGACY_FILE_INVENTORY.csv"
with destination.open("w", newline="", encoding="utf-8") as file:
    writer = csv.writer(file, lineterminator="\n")
    writer.writerow(["path", "git_lineage_clue", "working_tree_sha256", "port_baseline_commit",
                     "head_commit", "source_review"])
    writer.writerows(rows)
print(f"Recorded {len(rows)} files in {destination}")
