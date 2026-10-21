//! 可信启动 PATH 的软件工具链投影；不读取用户配置，不导入凭据或任意 home 目录。
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct CommandEnvironment {
    pub path: String,
    pub read_only_toolchains: Vec<PathBuf>,
}

pub fn command_environment(path: &OsStr) -> CommandEnvironment {
    let mut entries = Vec::new();
    let mut prefixes = Vec::new();
    for entry in std::env::split_paths(path) {
        let Some(text) = entry.to_str() else {
            continue;
        };
        let system = matches!(text, "/usr/bin" | "/bin" | "/usr/sbin" | "/sbin");
        let prefix = ["/opt/homebrew", "/usr/local"].into_iter().find(|prefix| {
            entry == Path::new(prefix).join("bin") || entry == Path::new(prefix).join("sbin")
        });
        if (system || prefix.is_some()) && !entries.iter().any(|old| old == text) {
            entries.push(text.to_owned());
        }
        if let Some(prefix) = prefix
            && !prefixes.contains(&prefix)
        {
            prefixes.push(prefix);
        }
    }
    // 已知系统目录作为后备；保留可信部署中已接入工具链的优先级。
    for system in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        if !entries.iter().any(|old| old == system) {
            entries.push(system.to_owned());
        }
    }
    let mut read_only_toolchains = Vec::new();
    for prefix in prefixes {
        let prefix = Path::new(prefix);
        // 不接受把安装前缀重定向到用户目录的部署，避免借 PATH 获得任意内容读取。
        if prefix.canonicalize().ok().as_deref() != Some(prefix) {
            continue;
        }
        for name in [
            "bin",
            "sbin",
            "lib",
            "lib64",
            "libexec",
            "include",
            "share",
            "opt",
            "Cellar",
            "Frameworks",
        ] {
            let path = prefix.join(name);
            if let Ok(actual) = path.canonicalize()
                && actual.starts_with(prefix)
                && actual.is_dir()
                && !read_only_toolchains.contains(&actual)
            {
                read_only_toolchains.push(actual);
            }
        }
        // OpenSSL 的公共启动配置和 CA 资源通常位于安装前缀的 etc 中。
        // 只接入这些具体资源，不能因此开放相邻服务配置或 private 私钥目录。
        for path in public_tls_resources(prefix) {
            if !read_only_toolchains.contains(&path) {
                read_only_toolchains.push(path);
            }
        }
    }
    CommandEnvironment {
        path: entries.join(":"),
        read_only_toolchains,
    }
}

fn public_tls_resources(prefix: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let Ok(entries) = std::fs::read_dir(prefix.join("etc")) else {
        return roots;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let openssl = name == "openssl"
            || name.strip_prefix("openssl@").is_some_and(|version| {
                !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            });
        if name != "ssl" && !openssl {
            continue;
        }
        for resource in ["openssl.cnf", "cert.pem", "certs"] {
            let path = entry.path().join(resource);
            if let Ok(actual) = path.canonicalize()
                && actual.starts_with(prefix)
                && (actual.is_file() || actual.is_dir())
                && !roots.contains(&actual)
            {
                roots.push(actual);
            }
        }
    }
    roots.sort();
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deployment_projection_keeps_tool_order_and_excludes_relative_user_and_secret_paths() {
        let value = command_environment(OsStr::new(
            ".:/tmp/tools:/Users/example/.nvm/bin:/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin:/usr/local/sbin:/bin",
        ));
        assert_eq!(
            value.path,
            "/opt/homebrew/bin:/usr/bin:/usr/local/sbin:/bin:/usr/sbin:/sbin"
        );
        assert!(
            value
                .read_only_toolchains
                .iter()
                .all(|p| !p.ends_with("etc") && !p.ends_with("var") && !p.starts_with("/Users"))
        );
    }

    #[test]
    fn tls_resources_exclude_private_keys_other_configs_and_redirected_files() {
        let fixture = tempfile::tempdir().unwrap();
        let prefix = fixture.path().canonicalize().unwrap();
        let tls = prefix.join("etc/openssl@3");
        std::fs::create_dir_all(tls.join("private")).unwrap();
        std::fs::create_dir(tls.join("certs")).unwrap();
        std::fs::write(tls.join("openssl.cnf"), "[openssl_init]\n").unwrap();
        std::fs::write(tls.join("private/key.pem"), "private").unwrap();
        std::fs::create_dir_all(prefix.join("etc/service")).unwrap();
        std::fs::write(prefix.join("etc/service/password"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", tls.join("cert.pem")).unwrap();
        let roots = public_tls_resources(&prefix);
        assert_eq!(roots, vec![tls.join("certs"), tls.join("openssl.cnf")]);
    }
}
