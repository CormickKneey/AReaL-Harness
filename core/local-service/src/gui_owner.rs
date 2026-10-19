use anyhow::{Context, Result, ensure};
use areal_protocol::service::Owner;
use std::{
    fs::File,
    os::fd::{AsRawFd, FromRawFd, RawFd},
};
use tokio::io::unix::AsyncFd;

pub const OWNER_ENV: &str = "AREAL_GUI_OWNER";
pub const LIFETIME_FD_ENV: &str = "AREAL_GUI_LIFETIME_FD";

pub fn from_env() -> Result<Option<Owner>> {
    match std::env::var(OWNER_ENV) {
        Ok(value) => parse_owner(&value).map(Some),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(error).context("invalid GUI owner environment"),
    }
}

pub fn parse_owner(value: &str) -> Result<Owner> {
    let owner: Owner = serde_json::from_str(value).context("invalid GUI application owner")?;
    let Owner::Gui {
        app_run_id,
        profile,
    } = &owner;
    uuid::Uuid::parse_str(app_run_id).context("GUI appRunId must be a UUID")?;
    ensure!(
        profile.is_absolute() && profile.is_dir() && profile.canonicalize()? == *profile,
        "GUI profile must be an absolute canonical directory"
    );
    Ok(owner)
}

pub fn check(expected: Option<&Owner>, actual: Option<&Owner>) -> Result<()> {
    ensure!(
        expected == actual,
        "service application owner mismatch; stop the original generation explicitly before starting another application session"
    );
    Ok(())
}

pub struct GuiLifetime(AsyncFd<File>);

impl GuiLifetime {
    pub fn from_env() -> Result<Option<Self>> {
        match std::env::var(LIFETIME_FD_ENV) {
            Ok(value) => Self::claim(value.parse().context("invalid GUI lifetime fd")?).map(Some),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(error) => Err(error).context("invalid GUI lifetime environment"),
        }
    }

    fn claim(fd: RawFd) -> Result<Self> {
        ensure!(fd >= 3, "GUI lifetime requires a non-stdio descriptor");
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        ensure!(flags >= 0, "invalid inherited GUI lifetime descriptor");
        ensure!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } >= 0,
            "could not prevent GUI lifetime descriptor inheritance"
        );
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        use std::os::unix::fs::FileTypeExt;
        ensure!(
            metadata.file_type().is_fifo() || metadata.file_type().is_socket(),
            "GUI lifetime descriptor must be a pipe or socket"
        );
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        ensure!(
            flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } >= 0,
            "could not configure GUI lifetime descriptor"
        );
        Ok(Self(AsyncFd::new(file)?))
    }

    pub fn as_raw_fd(&self) -> RawFd {
        self.0.get_ref().as_raw_fd()
    }

    pub fn check_open(&self) -> Result<()> {
        let mut byte = 0u8;
        let count = unsafe { libc::read(self.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) };
        if count < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock {
            return Ok(());
        }
        ensure!(count != 0, "GUI application lifetime ended");
        anyhow::bail!("invalid GUI application lifetime stream");
    }

    pub async fn closed(&self) -> Result<()> {
        loop {
            let mut ready = self.0.readable().await?;
            match ready.try_io(|inner| {
                let mut byte = 0u8;
                let count = unsafe {
                    libc::read(
                        inner.get_ref().as_raw_fd(),
                        (&mut byte as *mut u8).cast(),
                        1,
                    )
                };
                if count < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(count)
                }
            }) {
                Ok(Ok(0)) => return Ok(()),
                Ok(Ok(_)) => anyhow::bail!("unexpected data on GUI lifetime stream"),
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests;
