// Reads CPU, GPU and Neural Engine power from IOReport's "Energy Model" group and prints a
// single JSON line of watts.
//
// IOReport is a private framework, so it is loaded with dlopen rather than linked: a missing
// or renamed symbol then degrades to a null reading instead of refusing to launch the app.
// Unlike `powermetrics --samplers gpu_power`, it needs no administrator rights.
//
// Energy counters only mean something as a difference, so this takes two samples a short
// interval apart and divides. The interval is spent asleep, not spinning.
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef CFMutableDictionaryRef (*CopyChannelsFn)(CFStringRef, CFStringRef, uint64_t, uint64_t, uint64_t);
typedef void *(*CreateSubscriptionFn)(void *, CFMutableDictionaryRef, CFMutableDictionaryRef *, uint64_t, CFTypeRef);
typedef CFDictionaryRef (*CreateSamplesFn)(void *, CFMutableDictionaryRef, CFTypeRef);
typedef CFDictionaryRef (*CreateDeltaFn)(CFDictionaryRef, CFDictionaryRef, CFTypeRef);
typedef void (*IterateFn)(CFDictionaryRef, int (^)(CFDictionaryRef));
typedef CFStringRef (*ChannelStringFn)(CFDictionaryRef);
typedef int64_t (*IntegerValueFn)(CFDictionaryRef, int);

static const double kDefaultIntervalSeconds = 0.3;
static const double kMinIntervalSeconds = 0.05;
static const double kMaxIntervalSeconds = 2.0;

static void reportUnavailable(void) {
  printf("{\"cpuWatts\":null,\"gpuWatts\":null,\"aneWatts\":null}\n");
}

// Two groups are needed. "Energy Model" carries the CPU and GPU roll-ups; the Neural
// Engine's counter lives under "PMP" instead, where its channel is simply named ANE.
typedef struct {
  const char *group;
  const char *channel;
  double joules;
} EnergyChannel;

// Channels carry their own unit, and they are not all the same: on Apple Silicon the GPU
// reports nanojoules while the CPU reports millijoules. Reading the label rather than
// assuming one scale is what keeps the GPU from coming out a million times too small.
static double joulesFromUnit(int64_t value, const char *unit) {
  if (strstr(unit, "nJ")) return value / 1e9;
  if (strstr(unit, "uJ")) return value / 1e6;
  if (strstr(unit, "mJ")) return value / 1e3;
  if (strstr(unit, "J")) return (double)value;
  return -1;
}

static void printWatts(const char *key, double joules, double seconds, int trailingComma) {
  if (joules < 0) printf("\"%s\":null", key);
  else printf("\"%s\":%.3f", key, joules / seconds);
  if (trailingComma) printf(",");
}

int main(int argc, char **argv) {
  double seconds = argc > 1 ? atof(argv[1]) : kDefaultIntervalSeconds;
  if (!(seconds >= kMinIntervalSeconds && seconds <= kMaxIntervalSeconds)) seconds = kDefaultIntervalSeconds;

  void *library = dlopen("/usr/lib/libIOReport.dylib", RTLD_LAZY);
  if (!library) { reportUnavailable(); return 0; }

  CopyChannelsFn copyChannels = (CopyChannelsFn)dlsym(library, "IOReportCopyChannelsInGroup");
  CreateSubscriptionFn createSubscription = (CreateSubscriptionFn)dlsym(library, "IOReportCreateSubscription");
  CreateSamplesFn createSamples = (CreateSamplesFn)dlsym(library, "IOReportCreateSamples");
  CreateDeltaFn createDelta = (CreateDeltaFn)dlsym(library, "IOReportCreateSamplesDelta");
  IterateFn iterate = (IterateFn)dlsym(library, "IOReportIterate");
  ChannelStringFn channelName = (ChannelStringFn)dlsym(library, "IOReportChannelGetChannelName");
  ChannelStringFn channelUnit = (ChannelStringFn)dlsym(library, "IOReportChannelGetUnitLabel");
  IntegerValueFn integerValue = (IntegerValueFn)dlsym(library, "IOReportSimpleGetIntegerValue");
  if (!copyChannels || !createSubscription || !createSamples || !createDelta || !iterate
      || !channelName || !channelUnit || !integerValue) { reportUnavailable(); return 0; }

  EnergyChannel channelTable[] = {
    { "Energy Model", "CPU Energy", -1 },
    { "Energy Model", "GPU Energy", -1 },
    { "PMP", "ANE", -1 }
  };
  const size_t wantedCount = sizeof channelTable / sizeof *channelTable;
  // A block cannot capture an array, but it can capture a pointer and write through it.
  EnergyChannel *const wanted = channelTable;

  for (size_t g = 0; g < wantedCount; g++) {
    // Skip a group already walked: the first entry that names it does the whole pass.
    int alreadyDone = 0;
    for (size_t p = 0; p < g; p++) if (strcmp(wanted[p].group, wanted[g].group) == 0) alreadyDone = 1;
    if (alreadyDone) continue;

    CFStringRef groupName = CFStringCreateWithCString(kCFAllocatorDefault, wanted[g].group, kCFStringEncodingUTF8);
    CFMutableDictionaryRef channels = copyChannels(groupName, NULL, 0, 0, 0);
    CFRelease(groupName);
    if (!channels) continue;

    CFMutableDictionaryRef subscribed = NULL;
    void *subscription = createSubscription(NULL, channels, &subscribed, 0, NULL);
    if (!subscription) continue;

    CFDictionaryRef before = createSamples(subscription, subscribed, NULL);
    usleep((useconds_t)(seconds * 1e6));
    CFDictionaryRef after = createSamples(subscription, subscribed, NULL);
    CFDictionaryRef delta = createDelta(before, after, NULL);
    if (!delta) continue;

    const size_t groupIndex = g;
    iterate(delta, ^int(CFDictionaryRef channel) {
      char name[128] = "", unit[64] = "";
      CFStringRef nameRef = channelName(channel);
      CFStringRef unitRef = channelUnit(channel);
      if (!nameRef || !unitRef) return 0;
      if (!CFStringGetCString(nameRef, name, sizeof name, kCFStringEncodingUTF8)) return 0;
      if (!CFStringGetCString(unitRef, unit, sizeof unit, kCFStringEncodingUTF8)) return 0;
      for (size_t w = 0; w < wantedCount; w++) {
        if (strcmp(wanted[w].group, wanted[groupIndex].group) != 0) continue;
        if (strcmp(wanted[w].channel, name) != 0) continue;
        double joules = joulesFromUnit(integerValue(channel, 0), unit);
        if (joules >= 0) wanted[w].joules = joules;
      }
      return 0;
    });
  }

  double cpuJoules = wanted[0].joules, gpuJoules = wanted[1].joules, aneJoules = wanted[2].joules;

  printf("{");
  printWatts("cpuWatts", cpuJoules, seconds, 1);
  printWatts("gpuWatts", gpuJoules, seconds, 1);
  printWatts("aneWatts", aneJoules, seconds, 0);
  printf("}\n");
  return 0;
}
