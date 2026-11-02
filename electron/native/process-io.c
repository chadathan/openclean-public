#include <libproc.h>
#include <sys/resource.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int capacity = proc_listallpids(NULL, 0);
    if (capacity <= 0) return 1;
    pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
    if (!pids) return 1;
    int count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
    if (count < 0) { free(pids); return 1; }

    puts("pid,footprint,read,written");
    for (int i = 0; i < count; i++) {
        if (pids[i] <= 0) continue;
        struct rusage_info_v4 usage = {0};
        if (proc_pid_rusage(pids[i], RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) continue;
        printf("%d,%llu,%llu,%llu\n", pids[i],
               (unsigned long long)usage.ri_phys_footprint,
               (unsigned long long)usage.ri_diskio_bytesread,
               (unsigned long long)usage.ri_diskio_byteswritten);
    }
    free(pids);
    return 0;
}
