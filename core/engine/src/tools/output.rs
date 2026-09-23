//! Command-aware output views.
//!
//! The Runtime remains the source of truth for command output.  This module
//! only builds a bounded, lossless-enough view for the model after a command
//! has completed.  Unknown commands are deliberately left untouched.

use std::fmt::Write;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Projection {
    pub kind: &'static str,
    pub text: String,
    pub raw_bytes: usize,
    pub displayed_bytes: usize,
    pub omitted_lines: usize,
}

pub(crate) fn project(
    argv: &[String],
    stdout: &str,
    stderr: &str,
    exit_code: Option<i32>,
    complete: bool,
) -> Option<Projection> {
    if !complete || (stdout.is_empty() && stderr.is_empty()) {
        return None;
    }
    let kind = classify(argv)?;
    let raw = if stderr.is_empty() {
        stdout.to_owned()
    } else if stdout.is_empty() {
        stderr.to_owned()
    } else {
        format!("{stdout}\n{stderr}")
    };
    let lines: Vec<&str> = raw.lines().collect();
    let keep = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| useful(kind, line).then_some(index))
        .collect::<Vec<_>>();
    if keep.len() == lines.len() || keep.is_empty() {
        return None;
    }
    let mut text = String::new();
    let _ = writeln!(
        text,
        "[AReaL output view: kind={kind}, exit={}]",
        exit_code.map_or_else(|| "unknown".into(), |v| v.to_string())
    );
    let mut previous = None;
    let mut omitted_lines = 0;
    for index in keep {
        if let Some(last) = previous
            && index > last + 1
        {
            let omitted = index - last - 1;
            omitted_lines += omitted;
            let _ = writeln!(
                text,
                "… {omitted} lines omitted; call read_process to inspect raw output …"
            );
        }
        let _ = writeln!(text, "{}", lines[index]);
        previous = Some(index);
    }
    let raw_bytes = raw.len();
    let displayed_bytes = text.len();
    (displayed_bytes < raw_bytes).then_some(Projection {
        kind,
        text,
        raw_bytes,
        displayed_bytes,
        omitted_lines,
    })
}

fn classify(argv: &[String]) -> Option<&'static str> {
    let text = argv.join(" ").to_ascii_lowercase();
    let tokens = argv
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if tokens.iter().any(|s| s == "jest" || s.ends_with("/jest")) || word_present(&text, "jest") {
        Some("jest")
    } else if tokens.iter().any(|s| s == "karma" || s.ends_with("/karma"))
        || word_present(&text, "karma")
    {
        Some("karma")
    } else if tokens.iter().any(|s| s == "mocha" || s.ends_with("/mocha"))
        || word_present(&text, "mocha")
    {
        Some("mocha")
    } else if text.contains("cargo test") {
        Some("cargo-test")
    } else if tokens.iter().any(|s| s == "pytest") || word_present(&text, "pytest") {
        Some("pytest")
    } else if text.contains("go test") {
        Some("go-test")
    } else {
        None
    }
}

fn word_present(text: &str, word: &str) -> bool {
    text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|token| token == word)
}

fn useful(kind: &str, line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let common = lower.contains("assertionerror")
        || lower.contains("error")
        || lower.contains("expected")
        || lower.contains("received")
        || lower.contains("actual")
        || lower.starts_with("at ")
        || line.trim_start().starts_with("at ");
    match kind {
        "jest" => {
            common
                || [
                    "test suites:",
                    "tests:",
                    "snapshots:",
                    "time:",
                    "pass ",
                    "fail ",
                    "●",
                ]
                .iter()
                .any(|marker| lower.contains(marker))
        }
        "karma" => {
            common
                || ["executed", "total:", "failed", "karma", "browser:"]
                    .iter()
                    .any(|marker| lower.contains(marker))
        }
        "mocha" => {
            common
                || ["passing", "failing", "pending", "+ expected - actual"]
                    .iter()
                    .any(|marker| lower.contains(marker))
        }
        "cargo-test" => {
            common
                || ["test result:", "running ", "ok", "failed", "ignored"]
                    .iter()
                    .any(|marker| lower.contains(marker))
        }
        "pytest" => {
            common
                || [
                    "failed",
                    "passed",
                    "error",
                    "short test summary info",
                    "warnings summary",
                ]
                .iter()
                .any(|marker| lower.contains(marker))
        }
        "go-test" => {
            common
                || ["--- fail:", "--- pass:", "panic:", "ok ", "fail "]
                    .iter()
                    .any(|marker| lower.contains(marker))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }

    #[test]
    fn karma_timestamp_is_not_a_format_signal() {
        let output = "noise noise noise noise noise noise noise noise noise noise\nExecuted 1 of 1 SUCCESS (0.004 secs)\n12:30:01.123 INFO [karma]: Karma v6\n";
        let projection = project(&argv(&["npx", "karma", "start"]), output, "", Some(0), true);
        assert!(projection.is_some());
        assert!(projection.unwrap().text.contains("Executed"));
    }

    #[test]
    fn failures_and_assertions_survive_compaction() {
        let output = format!(
            "PASS src/a.test.js\n{}FAIL src/b.test.js\n  AssertionError: expected 1 to equal 2\n    at test (src/b.test.js:4:2)\nTests: 1 failed, 1 passed\n",
            (0..60).map(|i| format!("noise {i}\n")).collect::<String>()
        );
        let projection = project(&argv(&["npx", "jest"]), &output, "", Some(1), true).unwrap();
        assert!(projection.text.contains("FAIL src/b.test.js"));
        assert!(projection.text.contains("AssertionError"));
        assert!(projection.text.contains("Tests: 1 failed"));
        assert!(projection.omitted_lines > 0);
    }

    #[test]
    fn unknown_commands_are_passthrough() {
        assert!(
            project(
                &argv(&["bash", "-c", "printf hi"]),
                "hi\nnoise",
                "",
                Some(0),
                true
            )
            .is_none()
        );
    }

    #[test]
    fn shell_wrapped_test_commands_are_classified_by_command_text() {
        let output = format!(
            "{}FAIL src/b.test.js\nTests: 1 failed\n",
            (0..60).map(|i| format!("noise {i}\n")).collect::<String>()
        );
        let projection = project(
            &argv(&["/bin/bash", "-c", "npx jest --runInBand"]),
            &output,
            "",
            Some(1),
            true,
        )
        .unwrap();
        assert_eq!(projection.kind, "jest");
        assert!(projection.text.contains("Tests: 1 failed"));
    }
}
