#define _GNU_SOURCE
#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>
#include <unistd.h>
#ifndef __APPLE__
#include <dlfcn.h>
#endif

static _Atomic int entered;

static void await_release(int fd) {
    const char *target = getenv("FX_TEST_READ_TARGET");
    const char *record = getenv("FX_TEST_READ_ENTERED");
    const char *release = getenv("FX_TEST_READ_RELEASE");
    char actual[PATH_MAX], expected[PATH_MAX];
    if (!target || !record || !release || !realpath(target, expected)) return;
#ifdef __APPLE__
    if (fcntl(fd, F_GETPATH, actual)) return;
#else
    char link[64];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t count = readlink(link, actual, sizeof(actual) - 1);
    if (count < 0 || (size_t)count >= sizeof(actual) - 1) return;
    actual[count] = 0;
#endif
    if (strcmp(actual, expected) || atomic_exchange(&entered, 1)) return;
    int marker = open(record, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (marker >= 0) close(marker);
    // Bound a failed fixture's hold, including cleanup after a failed assertion.
    for (int attempt = 0; attempt < 15000 && access(release, F_OK); attempt++) usleep(1000);
}

#ifdef __APPLE__
static ssize_t gated_readv(int fd, const struct iovec *iov, int count) {
    await_release(fd);
    return readv(fd, iov, count);
}
static ssize_t gated_preadv(int fd, const struct iovec *iov, int count, off_t offset) {
    await_release(fd);
    return preadv(fd, iov, count, offset);
}
__attribute__((used, section("__DATA,__interpose")))
static const struct { const void *replacement; const void *original; } bindings[] = {
    { (const void *)gated_readv, (const void *)readv },
    { (const void *)gated_preadv, (const void *)preadv },
};
#else
ssize_t readv(int fd, const struct iovec *iov, int count) {
    ssize_t (*next)(int, const struct iovec *, int) = dlsym(RTLD_NEXT, "readv");
    await_release(fd);
    return next(fd, iov, count);
}
ssize_t preadv(int fd, const struct iovec *iov, int count, off_t offset) {
    ssize_t (*next)(int, const struct iovec *, int, off_t) = dlsym(RTLD_NEXT, "preadv");
    await_release(fd);
    return next(fd, iov, count, offset);
}
ssize_t preadv64(int fd, const struct iovec *iov, int count, off64_t offset) {
    ssize_t (*next)(int, const struct iovec *, int, off64_t) = dlsym(RTLD_NEXT, "preadv64");
    await_release(fd);
    return next(fd, iov, count, offset);
}
#endif
