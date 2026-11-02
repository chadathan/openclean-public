// Reads Apple Silicon CPU cluster temperatures through the private
// IOHIDEventSystemClient sensor API and prints a single JSON line.
// No administrator rights are required: the sensors are readable by any
// process, unlike `powermetrics --samplers smc`, which needs root and no
// longer reports a CPU die temperature on Apple Silicon at all.
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <string.h>

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDServiceClient *IOHIDServiceClientRef;
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;

extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
extern int IOHIDEventSystemClientSetMatching(IOHIDEventSystemClientRef client, CFDictionaryRef matching);
extern CFArrayRef IOHIDEventSystemClientCopyServices(IOHIDEventSystemClientRef client);
extern CFTypeRef IOHIDServiceClientCopyProperty(IOHIDServiceClientRef service, CFStringRef key);
extern IOHIDEventRef IOHIDServiceClientCopyEvent(IOHIDServiceClientRef service, int64_t type, int32_t options, int64_t timestamp);
extern double IOHIDEventGetFloatValue(IOHIDEventRef event, int32_t field);

// Usage page/usage pair that exposes the SoC's temperature sensors.
#define kSensorUsagePage 0xff00
#define kSensorUsage 0x0005
#define kIOHIDEventTypeTemperature 15
#define IOHIDEventFieldBase(type) ((type) << 16)

// CPU core clusters: performance (pACC) and efficiency (eACC). The GPU reports its own.
static const char *const kCpuSensorPrefixes[] = { "pACC MTR Temp", "eACC MTR Temp" };
static const char *const kGpuSensorPrefixes[] = { "GPU MTR Temp" };
static const char *const kAneSensorPrefixes[] = { "ANE MTR Temp" };
// The SoC die, reported by the memory-traffic ring and by the power manager.
static const char *const kSocSensorPrefixes[] = { "SOC MTR Temp", "PMGR SOC Die Temp" };
// The pack gauge. AppleSmartBattery reports a cell temperature that runs a few degrees
// cooler; this is the gauge's own reading, which is the one the other clusters are measured
// against here.
static const char *const kBatterySensorPrefixes[] = { "gas gauge battery" };
// The SSD. Apple names the internal flash sensors by channel, so a machine with more than one
// channel reports more than one and they are averaged like any other cluster.
static const char *const kNandSensorPrefixes[] = { "NAND" };

static int matchesAny(const char *name, const char *const *prefixes, size_t count) {
  for (size_t i = 0; i < count; i++) {
    if (strncmp(name, prefixes[i], strlen(prefixes[i])) == 0) return 1;
  }
  return 0;
}

// Both clusters come from one pass: enumerating the sensors is the expensive part, and
// splitting it across two invocations would pay that cost twice per poll.
typedef struct { double sum; unsigned long count; } Average;

// A power-gated sensor domain reports exactly 30.00 rather than going quiet: the GPU, ISP
// and Neural Engine all read it together while idle, on a die whose CPU clusters are at 48.
// Real samples are continuous floats, so an exact 30.00 is the sentinel, not a measurement,
// and reporting it as a temperature would claim the GPU is 18 degrees cooler than the die
// it sits on.
static const double kGatedSensorValue = 30.0;

static void addSample(Average *average, double value) {
  if (value <= 0 || value >= 120) return;
  if (value == kGatedSensorValue) return;
  average->sum += value;
  average->count++;
}

static void printAverage(const char *key, const Average *average, int trailingComma) {
  if (average->count == 0) printf("\"%s\":null,\"%sSensors\":0", key, key);
  else printf("\"%s\":%.1f,\"%sSensors\":%lu", key, average->sum / (double)average->count, key, average->count);
  if (trailingComma) printf(",");
}

static CFDictionaryRef createSensorMatching(void) {
  int page = kSensorUsagePage, usage = kSensorUsage;
  CFNumberRef pageRef = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &page);
  CFNumberRef usageRef = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &usage);
  const void *keys[] = { CFSTR("PrimaryUsagePage"), CFSTR("PrimaryUsage") };
  const void *values[] = { pageRef, usageRef };
  CFDictionaryRef matching = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2,
                                                &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFRelease(pageRef);
  CFRelease(usageRef);
  return matching;
}

static void reportUnavailable(void) {
  printf("{\"cpuC\":null,\"cpuCSensors\":0,\"gpuC\":null,\"gpuCSensors\":0,\"aneC\":null,\"aneCSensors\":0,"
         "\"socC\":null,\"socCSensors\":0,\"batteryC\":null,\"batteryCSensors\":0,"
         "\"hottestName\":null,\"hottestC\":null,\"readableSensors\":0}\n");
}

int main(void) {
  IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
  if (!client) { reportUnavailable(); return 0; }

  CFDictionaryRef matching = createSensorMatching();
  IOHIDEventSystemClientSetMatching(client, matching);
  CFRelease(matching);

  CFArrayRef services = IOHIDEventSystemClientCopyServices(client);
  if (!services) { CFRelease(client); reportUnavailable(); return 0; }

  Average cpu = { 0, 0 };
  Average gpu = { 0, 0 };
  Average ane = { 0, 0 };
  Average soc = { 0, 0 };
  Average battery = { 0, 0 };
  Average nand = { 0, 0 };
  // The single warmest reading anywhere on the board, whichever block it belongs to.
  char hottestName[256] = "";
  double hottestValue = -1;
  unsigned long readable = 0;
  for (CFIndex i = 0, total = CFArrayGetCount(services); i < total; i++) {
    IOHIDServiceClientRef service = (IOHIDServiceClientRef)CFArrayGetValueAtIndex(services, i);
    CFStringRef product = (CFStringRef)IOHIDServiceClientCopyProperty(service, CFSTR("Product"));
    if (!product) continue;

    char name[256];
    int named = CFStringGetCString(product, name, sizeof name, kCFStringEncodingUTF8);
    CFRelease(product);
    if (!named) continue;
    int isCpu = matchesAny(name, kCpuSensorPrefixes, sizeof kCpuSensorPrefixes / sizeof *kCpuSensorPrefixes);
    int isGpu = matchesAny(name, kGpuSensorPrefixes, sizeof kGpuSensorPrefixes / sizeof *kGpuSensorPrefixes);
    int isAne = matchesAny(name, kAneSensorPrefixes, sizeof kAneSensorPrefixes / sizeof *kAneSensorPrefixes);
    int isSoc = matchesAny(name, kSocSensorPrefixes, sizeof kSocSensorPrefixes / sizeof *kSocSensorPrefixes);
    int isBattery = matchesAny(name, kBatterySensorPrefixes, sizeof kBatterySensorPrefixes / sizeof *kBatterySensorPrefixes);
    int isNand = matchesAny(name, kNandSensorPrefixes, sizeof kNandSensorPrefixes / sizeof *kNandSensorPrefixes);

    IOHIDEventRef event = IOHIDServiceClientCopyEvent(service, kIOHIDEventTypeTemperature, 0, 0);
    if (!event) continue;
    double value = IOHIDEventGetFloatValue(event, IOHIDEventFieldBase(kIOHIDEventTypeTemperature));
    CFRelease(event);

    // Every live sensor counts towards the total and the hot spot, not only the named
    // clusters: the warmest point on the board is often a PMU sensor.
    if (value > 0 && value < 120 && value != kGatedSensorValue) {
      readable++;
      if (value > hottestValue) {
        hottestValue = value;
        snprintf(hottestName, sizeof hottestName, "%s", name);
      }
    }

    if (isCpu) addSample(&cpu, value);
    else if (isGpu) addSample(&gpu, value);
    else if (isAne) addSample(&ane, value);
    else if (isSoc) addSample(&soc, value);
    else if (isBattery) addSample(&battery, value);
    else if (isNand) addSample(&nand, value);
  }

  CFRelease(services);
  CFRelease(client);

  printf("{");
  printAverage("cpuC", &cpu, 1);
  printAverage("gpuC", &gpu, 1);
  printAverage("aneC", &ane, 1);
  printAverage("socC", &soc, 1);
  printAverage("batteryC", &battery, 1);
  printAverage("nandC", &nand, 1);
  if (hottestValue < 0) printf("\"hottestName\":null,\"hottestC\":null,");
  else printf("\"hottestName\":\"%s\",\"hottestC\":%.1f,", hottestName, hottestValue);
  printf("\"readableSensors\":%lu}\n", readable);
  return 0;
}
