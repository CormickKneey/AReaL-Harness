#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// 仅测试库替换真实 libc 边界；生产助手不读取这些环境变量。
static int attempts[4];

static int fault(const char *path, int flags) {
  const char *mode = getenv("AREAL_TEST_FS_FAULT");
  const char *root = getenv("AREAL_TEST_FS_ROOT");
  int index = -1;
  if (!mode || !root) return 0;
  if ((flags & O_ACCMODE) == O_RDONLY) {
    if (!strcmp(path, root)) index = 0;
    else if (!strcmp(path, "nested")) index = 1;
    else if (!strcmp(path, "data.bin")) index = 2;
  } else if (flags & O_CREAT) index = 3;
  if (index < 0) return 0;
  ++attempts[index];
  const char *log = getenv("AREAL_TEST_FS_LOG");
  if (log) {
    int fd = open(log, O_WRONLY | O_APPEND | O_CREAT, 0600);
    if (fd >= 0) {
      char record = "RDFW"[index];
      (void)write(fd, &record, 1);
      close(fd);
    }
  }
  if (!strcmp(mode, "denied") && index == 0) return EACCES;
  if (!strcmp(mode, "readOnce") && index < 3 && attempts[index] == 1) return EINTR;
  if (!strcmp(mode, "writeOnce") && index == 3 && attempts[index] == 1) return EINTR;
  return 0;
}

static int interrupted_open(const char *path, int flags, ...) {
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list args;
    va_start(args, flags);
    mode = (mode_t)va_arg(args, int);
    va_end(args);
  }
  int error = fault(path, flags);
  if (error) { errno = error; return -1; }
  return open(path, flags, mode);
}

static int interrupted_openat(int parent, const char *path, int flags, ...) {
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list args;
    va_start(args, flags);
    mode = (mode_t)va_arg(args, int);
    va_end(args);
  }
  int error = fault(path, flags);
  if (error) { errno = error; return -1; }
  return openat(parent, path, flags, mode);
}

__attribute__((used)) static const struct {
  const void *replacement;
  const void *original;
} replacements[] __attribute__((section("__DATA,__interpose"))) = {
  {(const void *)interrupted_open, (const void *)open},
  {(const void *)interrupted_openat, (const void *)openat},
};
