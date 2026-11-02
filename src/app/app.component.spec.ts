import { TestBed } from '@angular/core/testing';
import { shouldRunMetrics } from '../../electron/metrics-policy';
import { AppComponent } from './app.component';
import { SystemMonitorService } from './dashboard/system-monitor.service';

describe('background monitoring setting', () => {
  let originalApi: Window['electronAPI'];
  let api: Pick<NonNullable<Window['electronAPI']>, 'getBackgroundMonitoring' | 'setBackgroundMonitoring'>;
  let monitor: SystemMonitorService;
  let startPolling: jasmine.Spy;
  let stopPolling: jasmine.Spy;

  beforeEach(async () => {
    originalApi = window.electronAPI;
    api = {
      getBackgroundMonitoring: jasmine.createSpy('getBackgroundMonitoring').and.resolveTo({ enabled: true }),
      setBackgroundMonitoring: jasmine.createSpy('setBackgroundMonitoring').and.callFake(async enabled => ({ enabled }))
    };
    window.electronAPI = api as Window['electronAPI'];
    startPolling = jasmine.createSpy('startPolling');
    stopPolling = jasmine.createSpy('stopPolling');
    monitor = { startPolling, stopPolling } as unknown as SystemMonitorService;

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [{ provide: SystemMonitorService, useValue: monitor }]
    }).compileComponents();
  });

  afterEach(() => {
    window.electronAPI = originalApi;
    TestBed.resetTestingModule();
  });

  it('loads the saved value and persists a change from Settings', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const component = fixture.componentInstance;
    component.setTab('settings');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.backgroundMonitoring()).toBeTrue();
    const toggle = fixture.nativeElement.querySelector('[aria-label="Background monitoring"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    await component.toggleBackgroundMonitoring();
    fixture.detectChanges();
    expect(api.setBackgroundMonitoring).toHaveBeenCalledOnceWith(false);
    expect(component.backgroundMonitoring()).toBeFalse();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('subscribes only while the focused Overview is open', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const component = fixture.componentInstance;
    startPolling.calls.reset();
    stopPolling.calls.reset();

    component.onWindowBlur();
    component.setTab('overview');
    expect(stopPolling).toHaveBeenCalled();
    expect(startPolling).not.toHaveBeenCalled();

    component.onWindowFocus();
    expect(startPolling).toHaveBeenCalledTimes(1);

    component.setTab('settings');
    expect(stopPolling).toHaveBeenCalledTimes(3);
    fixture.destroy();
  });
});

describe('metrics sampling policy', () => {
  it('runs while at least one view is subscribed when background mode is off', () => {
    expect(shouldRunMetrics(false, 0)).toBeFalse();
    expect(shouldRunMetrics(false, 1)).toBeTrue();
    expect(shouldRunMetrics(false, 2)).toBeTrue();
  });

  it('keeps sampling with no open views only when background mode is on', () => {
    expect(shouldRunMetrics(true, 0)).toBeTrue();
    expect(shouldRunMetrics(true, 1)).toBeTrue();
  });
});
