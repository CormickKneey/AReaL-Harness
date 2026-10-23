use super::*;

fn fixture() -> (tempfile::TempDir, PathBuf, BTreeMap<String, OsString>) {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().canonicalize().unwrap();
    let env = BTreeMap::from([("HOME".into(), home.clone().into_os_string())]);
    (temp, home, env)
}

fn write(path: &Path, data: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, data).unwrap();
}

fn installation(home: &Path, relative: &str) -> PathBuf {
    let root = home.join(relative);
    fs::create_dir_all(root.join("bin")).unwrap();
    write(&root.join("lib/resource"), "runtime library");
    root
}

#[test]
fn nvm_resolves_default_alias_chains_and_numeric_versions_without_latest_guessing() {
    let (_temp, home, env) = fixture();
    installation(&home, ".nvm/versions/node/v22.9.0");
    let wanted = installation(&home, ".nvm/versions/node/v22.10.0");
    installation(&home, ".nvm/versions/node/v24.1.0");
    write(&home.join(".nvm/alias/default"), "lts/test\n");
    write(&home.join(".nvm/alias/lts/test"), "22\n");
    let found = discover(&[], &env);
    assert_eq!(found.bins, [wanted.join("bin")]);
    assert_eq!(found.roots, [wanted]);
    write(&home.join(".nvm/alias/default"), "system\n");
    assert!(discover(&[], &env).bins.is_empty());
    fs::remove_file(home.join(".nvm/alias/default")).unwrap();
    assert!(discover(&[], &env).bins.is_empty());
}

#[test]
fn activated_path_wins_over_default_and_custom_root_is_supported() {
    let (_temp, home, mut env) = fixture();
    let nvm = home.join("custom node manager");
    env.insert("NVM_DIR".into(), nvm.clone().into_os_string());
    let active = installation(&nvm, "versions/node/v20.1.0");
    installation(&nvm, "versions/node/v24.1.0");
    write(&nvm.join("alias/default"), "24\n");
    let found = discover(&[active.join("bin")], &env);
    assert_eq!(found.bins, [active.join("bin")]);
    assert_eq!(found.roots, [active]);
}

#[cfg(unix)]
#[test]
fn fnm_default_and_temporary_activation_links_resolve_to_only_the_selected_install() {
    use std::os::unix::fs::symlink;
    let (_temp, home, mut env) = fixture();
    let root = home.join("fnm");
    env.insert("FNM_DIR".into(), root.clone().into_os_string());
    let wanted = installation(&root, "node-versions/v22.1.0/installation");
    let active = installation(&root, "node-versions/v20.1.0/installation");
    fs::create_dir_all(root.join("aliases")).unwrap();
    symlink(&wanted, root.join("aliases/default")).unwrap();
    assert_eq!(discover(&[], &env).bins, [wanted.join("bin")]);
    let link = home.join("multishell");
    symlink(&active, &link).unwrap();
    let found = discover(&[link.join("bin")], &env);
    assert_eq!(found.replacements[&link.join("bin")], [active.join("bin")]);
    assert_eq!(found.roots, [active.parent().unwrap().to_owned()]);
}

#[test]
fn mise_and_asdf_select_multiple_languages_but_do_not_load_environment_or_hooks() {
    let (_temp, home, env) = fixture();
    let node = installation(&home, ".local/share/mise/installs/node/22.1.0");
    installation(&home, ".local/share/mise/installs/node/24.1.0");
    let python = installation(&home, ".local/share/mise/installs/python/3.13.1");
    write(
        &home.join(".config/mise/config.toml"),
        "[tools]\nnode = '22'\npython = { version = '3.13' }\n[env]\nPRIVATE_TOKEN = 'do not export'\n[tasks.hook]\nrun = 'touch SHOULD_NOT_EXIST'\n",
    );
    let ruby = installation(&home, ".asdf/installs/ruby/3.3.0");
    write(&home.join(".tool-versions"), "ruby 3.3.0 # pinned\n");
    let found = discover(&[], &env);
    assert_eq!(
        found.bins,
        [node.join("bin"), python.join("bin"), ruby.join("bin")]
    );
    for root in &found.roots {
        assert!(!home.join(".config/mise/config.toml").starts_with(root));
        assert!(!home.join(".tool-versions").starts_with(root));
    }
    assert!(!home.join("SHOULD_NOT_EXIST").exists());
}

#[test]
fn pyenv_rbenv_and_rustup_use_real_binaries_without_host_home() {
    let (_temp, home, env) = fixture();
    let python = installation(&home, ".pyenv/versions/3.13.1");
    installation(&home, ".pyenv/versions/3.12.2");
    write(&home.join(".pyenv/version"), "3.13.1\n");
    let ruby = installation(&home, ".rbenv/versions/3.3.0");
    write(&home.join(".rbenv/version"), "3.3.0\n");
    let rust = installation(&home, ".rustup/toolchains/stable-test-target");
    write(
        &home.join(".rustup/settings.toml"),
        "default_toolchain = 'stable-test-target'\n",
    );
    fs::create_dir_all(home.join(".cargo/bin")).unwrap();
    let found = discover(&[], &env);
    assert_eq!(
        found.replacements[&home.join(".pyenv/shims")],
        [python.join("bin")]
    );
    assert_eq!(
        found.replacements[&home.join(".rbenv/shims")],
        [ruby.join("bin")]
    );
    assert_eq!(
        found.replacements[&home.join(".cargo/bin")],
        [rust.join("bin"), home.join(".cargo/bin")]
    );
    assert!(
        found
            .roots
            .iter()
            .all(|p| !home.join(".cargo/credentials.toml").starts_with(p))
    );
}

#[test]
fn volta_pins_node_and_package_managers_in_order() {
    let (_temp, home, env) = fixture();
    let node = installation(&home, ".volta/tools/image/node/22.1.0");
    installation(&home, ".volta/tools/image/node/24.1.0");
    let npm = installation(&home, ".volta/tools/image/npm/10.0.0");
    write(
        &home.join(".volta/tools/user/platform.json"),
        r#"{"node":"22.1.0","npm":"10.0.0"}"#,
    );
    assert_eq!(
        discover(&[], &env).replacements[&home.join(".volta/bin")],
        [npm.join("bin"), node.join("bin")]
    );
}

#[test]
fn standalone_user_binaries_do_not_grant_home_or_adjacent_credentials() {
    let (_temp, home, env) = fixture();
    for directory in [".local/bin", ".bun/bin", ".deno/bin", ".cargo/bin"] {
        fs::create_dir_all(home.join(directory)).unwrap();
    }
    let found = discover(&[], &env);
    assert_eq!(found.bins.len(), 4);
    for private in [
        ".ssh/key",
        ".npmrc",
        ".cargo/credentials.toml",
        ".local/share/private",
    ] {
        assert!(
            !found
                .roots
                .iter()
                .any(|p| home.join(private).starts_with(p))
        );
    }
}

#[cfg(unix)]
#[test]
fn redirected_installations_and_bins_never_grant_external_contents() {
    use std::os::unix::fs::symlink;
    let (_temp, home, env) = fixture();
    let outside = installation(&home, "private");
    let base = home.join(".nvm/versions/node");
    fs::create_dir_all(&base).unwrap();
    symlink(&outside, base.join("v22.1.0")).unwrap();
    write(&home.join(".nvm/alias/default"), "22\n");
    assert!(discover(&[], &env).roots.is_empty());
    fs::remove_file(base.join("v22.1.0")).unwrap();
    fs::create_dir(base.join("v22.1.0")).unwrap();
    symlink(outside.join("bin"), base.join("v22.1.0/bin")).unwrap();
    assert!(discover(&[], &env).roots.is_empty());
}

#[test]
fn alias_cycles_malformed_files_and_oversized_directories_do_not_select_arbitrary_versions() {
    let (_temp, home, env) = fixture();
    installation(&home, ".nvm/versions/node/v22.1.0");
    write(&home.join(".nvm/alias/default"), "loop");
    write(&home.join(".nvm/alias/loop"), "default");
    assert!(discover(&[], &env).bins.is_empty());
    write(&home.join(".nvm/alias/default"), "../../private");
    assert!(discover(&[], &env).bins.is_empty());
    let root = home.join("too-many");
    for i in 0..=MAX_ENTRIES {
        fs::create_dir_all(root.join(i.to_string())).unwrap();
    }
    assert!(children(&root).is_empty());
    write(
        &home.join("too-large"),
        &"x".repeat(MAX_CONFIG as usize + 1),
    );
    assert!(small_file(&home.join("too-large")).is_none());
}

#[cfg(unix)]
#[test]
fn configuration_fifos_and_symlinks_do_not_block_or_read_other_files() {
    use std::{ffi::CString, os::unix::fs::symlink};
    let (_temp, home, _env) = fixture();
    let fifo = home.join("fifo");
    let name = CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(small_file(&fifo).is_none());
    write(&home.join("secret"), "private");
    symlink(home.join("secret"), home.join("link")).unwrap();
    assert!(small_file(&home.join("link")).is_none());
}

#[cfg(unix)]
#[test]
fn user_cli_links_grant_only_known_venv_and_interpreter_resources() {
    use std::os::unix::fs::symlink;
    let (_temp, home, env) = fixture();
    let venv = installation(&home, ".local/share/uv/tools/linter");
    let python = installation(&home, ".local/share/uv/python/cpython-test");
    write(&venv.join("bin/linter"), "script");
    write(&python.join("bin/python3"), "python");
    let bin = home.join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    symlink(venv.join("bin/linter"), bin.join("linter")).unwrap();
    symlink(python.join("bin/python3"), venv.join("bin/python")).unwrap();
    write(&home.join("private"), "secret");
    symlink(home.join("private"), bin.join("unrecognized")).unwrap();
    let found = discover(&[], &env);
    assert!(found.roots.contains(&venv));
    assert!(found.roots.contains(&python));
    assert!(
        !found
            .roots
            .iter()
            .any(|p| home.join("private").starts_with(p))
    );
}

#[cfg(unix)]
#[test]
fn single_binary_and_macos_java_layouts_are_discovered_without_plugins() {
    use std::os::unix::fs::PermissionsExt;
    let (_temp, home, env) = fixture();
    let uv = home.join(".local/share/mise/installs/uv/0.8.0");
    write(&uv.join("uv"), "#!/bin/sh\nexit 0\n");
    fs::set_permissions(uv.join("uv"), fs::Permissions::from_mode(0o755)).unwrap();
    let java = home.join(".local/share/mise/installs/java/21/Contents/Home/bin");
    fs::create_dir_all(&java).unwrap();
    let found = discover(&[], &env);
    assert!(found.bins.contains(&uv));
    assert!(found.bins.contains(&java));
}

#[test]
fn invalid_mise_configuration_does_not_silently_choose_a_different_default() {
    let (_temp, home, env) = fixture();
    let installed = installation(&home, ".local/share/mise/installs/node/22.1.0");
    write(
        &home.join(".config/mise/config.toml"),
        "[tools\nnode = '24'",
    );
    let found = discover(&[], &env);
    assert!(found.bins.is_empty());
    assert!(!found.notices.is_empty());
    let active = discover(&[installed.join("bin")], &env);
    assert_eq!(active.bins, [installed.join("bin")]);
}
