use anyhow::{Context, Result};
use std::process::Command;

pub use areal_local_service::LocalArgs;

pub fn launch(args: &super::Args) -> Result<()> {
    let binary = std::env::current_exe().context("locate TUI executable")?;
    // Embed the existing trusted launcher so installed binaries need no source checkout.
    // exec keeps one owner for Core/Runtime even if the original TUI process is signalled.
    let mut command = Command::new("/usr/bin/python3");
    command
        // The task's cwd, PATH and PYTHONPATH must not supply launcher code.
        .args(["-I", "-S", "-c"])
        .arg(include_str!("../../../scripts/launch.py"))
        .arg("--bin-dir")
        .arg(binary.parent().context("locate sibling Harness binaries")?)
        .arg("--tui");
    // 客户端选项必须穿过 launcher，且不能进入 Core 配置参数。
    if let Some(theme) = args.ui.theme {
        command.arg(format!("--theme={}", theme.key()));
    }
    if let Some(color) = args.ui.color {
        command.arg(format!("--color={}", color.key()));
    }
    if let Some(path) = &args.ui.tui_config {
        let mut argument = std::ffi::OsString::from("--tui-config=");
        argument.push(std::path::absolute(path).context("locate TUI preferences")?);
        command.arg(argument);
    }
    for (flag, value) in [("--no-logo", args.ui.no_logo), ("--ascii", args.ui.ascii)] {
        if let Some(value) = value {
            command.arg(format!("{flag}={value}"));
        }
    }
    command.args(args.local.launcher_args());
    if let Some(value) = &args.input_file {
        command.arg("--input-file").arg(value);
    }
    for (flag, value) in [
        ("--resume", &args.resume),
        ("--prompt", &args.prompt),
        ("--goal", &args.goal),
    ] {
        if let Some(value) = value {
            command.arg(format!("{flag}={value}"));
        }
    }
    if let Some(budget) = args.goal_token_budget {
        command.arg(format!("--goal-token-budget={budget}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec()).context("start local Harness (Python 3.10+ is required)")
    }
    #[cfg(not(unix))]
    anyhow::bail!("local Harness requires Unix; use --endpoint to connect to an existing Core")
}

#[cfg(test)]
mod tests {
    use super::super::Args;
    use clap::Parser;

    #[test]
    fn default_is_local_and_remote_alias_is_explicit() {
        assert!(
            Args::try_parse_from(["areal-tui"])
                .unwrap()
                .endpoint
                .is_none()
        );
        let args = Args::try_parse_from([
            "areal-tui",
            "--remote",
            "ws://127.0.0.1:4500",
            "--resume",
            "thread-id",
        ])
        .unwrap();
        assert_eq!(args.endpoint.as_deref(), Some("ws://127.0.0.1:4500"));
        assert_eq!(args.resume.as_deref(), Some("thread-id"));
    }

    #[test]
    fn remote_rejects_local_configuration_instead_of_ignoring_it() {
        for local in [
            vec!["--config", "/tmp/config.toml"],
            vec!["--model-provider", "company"],
            vec!["--workspace", "/tmp/workspace"],
            vec!["--data-dir", "/tmp/data"],
            vec!["--model", "model"],
            vec!["--model-endpoint", "http://localhost/model"],
            vec!["--api-key-env", "KEY"],
            vec!["--allow-write"],
        ] {
            let mut args = vec!["areal-tui", "--endpoint", "ws://127.0.0.1:4500"];
            args.extend(local);
            assert!(Args::try_parse_from(args).is_err());
        }
    }
    #[test]
    fn appearance_options_are_valid_for_both_launch_modes() {
        for endpoint in [vec![], vec!["--endpoint", "ws://127.0.0.1:4500"]] {
            let mut args = vec!["areal-tui"];
            args.extend(endpoint);
            args.extend([
                "--theme=light",
                "--color=never",
                "--ascii",
                "--no-logo=false",
            ]);
            let args = Args::try_parse_from(args).unwrap();
            assert_eq!(args.ui.theme, Some(crate::theme::Theme::Light));
            assert_eq!(args.ui.color, Some(crate::theme::ColorMode::Never));
            assert_eq!(args.ui.no_logo, Some(false));
            assert_eq!(args.ui.ascii, Some(true));
        }
    }
}
