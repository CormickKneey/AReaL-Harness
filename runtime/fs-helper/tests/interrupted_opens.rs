#![cfg(target_os = "macos")]

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command};

struct Fixture {
    temp: tempfile::TempDir,
    library: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let library = temp.path().join("interrupt.dylib");
        let output = Command::new("/usr/bin/cc")
            .args(["-dynamiclib", "-Wall", "-Werror", "-o"])
            .arg(&library)
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/interrupted_opens.c"))
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        fs::create_dir(temp.path().join("nested")).unwrap();
        fs::write(temp.path().join("nested/data.bin"), b"exact\0\xffpayload").unwrap();
        Self { temp, library }
    }

    fn run(&self, fault: &str, command: Value) -> (Value, String) {
        let log = self.temp.path().join(format!("{fault}.log"));
        let request = json!({"root": self.temp.path(), "command": command});
        // 系统父进程保持真实产品助手可启动；插桩只进入助手，不加载到系统 Python。
        let output = Command::new("/usr/bin/python3")
            .args(["-I", "-S", "-c", "import os,subprocess,sys; e=dict(os.environ); e['DYLD_INSERT_LIBRARIES']=sys.argv[1]; r=subprocess.run(sys.argv[2:],env=e); sys.exit(r.returncode)"])
            .arg(&self.library)
            .arg(env!("CARGO_BIN_EXE_areal-runtime-fs"))
            .arg(request.to_string())
            .env("AREAL_TEST_FS_ROOT", self.temp.path())
            .env("AREAL_TEST_FS_FAULT", fault)
            .env("AREAL_TEST_FS_LOG", &log)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        (
            serde_json::from_slice(&output.stdout).unwrap(),
            fs::read_to_string(log).expect("real helper must load the fault injection library"),
        )
    }
}

#[test]
fn interrupted_root_directory_and_file_opens_preserve_the_complete_read() {
    let f = Fixture::new();
    let (response, attempts) = f.run(
        "readOnce",
        json!({"kind":"read", "path":"nested/data.bin", "maxBytes":64}),
    );
    assert_eq!(
        attempts, "RRDDFF",
        "each interrupted open retries only itself"
    );
    let result = &response["result"];
    assert_eq!(
        STANDARD
            .decode(result["dataBase64"].as_str().unwrap())
            .unwrap(),
        b"exact\0\xffpayload"
    );
    assert_eq!(result["eof"], true);
    assert_eq!(result["size"], 14);
}

#[test]
fn permission_denial_and_file_creation_are_not_retried() {
    let f = Fixture::new();
    let (denied, attempts) = f.run(
        "denied",
        json!({"kind":"read", "path":"nested/data.bin", "maxBytes":64}),
    );
    assert_eq!(denied["error"]["code"], "PERMISSION_DENIED");
    assert_eq!(attempts, "R");
    let (interrupted, attempts) = f.run(
        "writeOnce",
        json!({"kind":"write", "path":"nested/new.bin", "dataBase64":STANDARD.encode(b"new"), "expected":{"kind":"absent"}}),
    );
    assert_eq!(
        interrupted["error"]["code"], "UNAVAILABLE",
        "creation must not be replayed"
    );
    assert_eq!(attempts, "RDW");
    assert!(!f.temp.path().join("nested/new.bin").exists());
    assert_eq!(
        fs::read(f.temp.path().join("nested/data.bin")).unwrap(),
        b"exact\0\xffpayload"
    );
}
