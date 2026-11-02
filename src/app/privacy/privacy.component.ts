import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FontAwesomeModule } from '@fortawesome/angular-fontawesome';
import { faArrowRight, faBoxArchive, faCircleCheck, faEnvelope, faGear, faLock, faRotateLeft, faShieldHalved, faTrashCan } from '@fortawesome/free-solid-svg-icons';

type PermissionState = 'checking' | 'granted' | 'missing';

@Component({
  selector: 'oc-privacy', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FontAwesomeModule],
  template: `
    <section class="privacy-page">
      <div class="page-heading">
        <div><p class="eyebrow">PRIVACY & ACCESS</p><h1>Permission Center</h1><p class="muted">Choose what OpenClean can access. You stay in control and can change this anytime.</p></div>
      </div>

      <section class="access-hero" [class.granted]="granted()" [class.checking]="state() === 'checking'">
        <span class="hero-icon"><fa-icon [icon]="granted() ? faCircleCheck : faShieldHalved" /></span>
        <div class="hero-copy">
          <p class="hero-kicker">MACOS PERMISSION · FULL DISK ACCESS</p>
          <h2>{{ state() === 'checking' ? 'Checking access…' : granted() ? 'Full Disk Access is on' : 'Full Disk Access is off' }}</h2>
          <p>{{ granted() ? 'OpenClean can measure and clean the folders macOS protects. You can turn this off in System Settings at any time.' : 'Optional. Turn it on only if you want OpenClean to reach the folders macOS protects.' }}</p>
          <div class="hero-actions">
            <button class="hero-primary" type="button" (click)="openSystemSettings()"><fa-icon [icon]="faGear" />{{ granted() ? 'Manage in Settings' : 'Open System Settings' }}<fa-icon [icon]="faArrowRight" /></button>
            <button class="hero-secondary" type="button" [disabled]="checking()" (click)="checkAccess()"><fa-icon [icon]="faRotateLeft" />{{ checking() ? 'Checking…' : 'Check again' }}</button>
            <small>Checked {{ lastChecked() }}</small>
          </div>
          @if (settingsOpened() && !granted()) {
            <ol class="hero-steps">
              <li><b>1</b>In System Settings, find <strong>OpenClean</strong> under Full Disk Access</li>
              <li><b>2</b>Switch it on — macOS may ask you to reopen the app</li>
              <li><b>3</b>Come back here and press <strong>Check again</strong></li>
            </ol>
          }
          @if (notice()) { <p class="hero-notice" role="status">{{ notice() }}</p> }
        </div>
        <span class="hero-orb orb-one"></span><span class="hero-orb orb-two"></span>
      </section>

      <section class="unlocks">
        <header><h2>What it unlocks</h2><p>Everything else in OpenClean works without it.</p></header>
        <ul>
          @for (item of unlocks; track item.title) {
            <li>
              <span class="unlock-icon" [class]="'unlock-icon tone-' + item.tone"><fa-icon [icon]="item.icon" /></span>
              <div><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></div>
              <em [class.on]="granted()">{{ granted() ? 'Available' : 'Needs access' }}</em>
            </li>
          }
        </ul>
      </section>

      <p class="reassurance"><fa-icon [icon]="faLock" />Checking access only reads a permission status — it never scans, moves, or deletes files. Protected folders are read only when you run a feature that needs them.</p>
    </section>
  `,
  styles: [`
    .privacy-page { padding:12px 0 32px; display:grid; gap:22px; }
    .access-hero { position:relative; isolation:isolate; overflow:hidden; display:grid; grid-template-columns:56px minmax(0,1fr); gap:22px; padding:32px 34px; border:1px solid #ffffff48; border-radius:22px; color:#fff; background:radial-gradient(ellipse at 80% 20%,#7b45b1 0,transparent 45%),linear-gradient(112deg,#301058 0%,#552078 48%,#155f5f 115%); box-shadow:0 22px 48px #36135a26,inset 0 1px #ffffff30; transition:background .3s; }
    .access-hero.granted { background:radial-gradient(ellipse at 80% 20%,#428c86 0,transparent 45%),linear-gradient(112deg,#183954 0%,#254b78 52%,#176455 118%); }
    .access-hero > :not(.hero-orb) { position:relative; z-index:1; }
    .hero-icon { width:54px; height:54px; display:grid; place-items:center; border:1px solid #ffffff4c; border-radius:17px; color:#fff; background:#ffffff1f; font-size:22px; box-shadow:inset 0 1px #ffffff30; }
    .access-hero.checking .hero-icon { animation:pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity:.55; } }
    .hero-kicker { margin:0 0 10px; color:#d6c2f0; font-size:10px; font-weight:700; letter-spacing:.16em; }
    .access-hero.granted .hero-kicker { color:#bfe9df; }
    .hero-copy h2 { margin:0; color:#fff; font-size:clamp(24px,2.8vw,32px); letter-spacing:-.04em; }
    .hero-copy > p { max-width:58ch; margin:10px 0 0; color:#eee2fa; font-size:13px; line-height:1.65; }
    .hero-actions { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-top:22px; }
    .hero-actions button { display:inline-flex; align-items:center; gap:9px; height:38px; padding:0 15px; border-radius:11px; font:inherit; font-size:12px; font-weight:700; transition:transform .12s, box-shadow .12s, background .12s; }
    .hero-primary { border:1px solid #d4fff0; background:linear-gradient(110deg,#baffdf,#77e4bd); color:#184b47; box-shadow:0 9px 24px #062f352c,inset 0 1px #fff; }
    .hero-primary:hover { transform:translateY(-1px); box-shadow:0 12px 28px #062f3540,inset 0 1px #fff; }
    .hero-secondary { border:1px solid #ffffff45; background:#ffffff14; color:#fff; }
    .hero-secondary:hover:not(:disabled) { background:#ffffff26; }
    .hero-actions small { margin-left:4px; color:#d9c9ef; font-size:11px; }
    .hero-steps { display:grid; gap:9px; max-width:560px; margin:20px 0 0; padding:15px 17px; border:1px solid #ffffff2e; border-radius:14px; background:#ffffff12; list-style:none; }
    .hero-steps li { display:flex; align-items:center; gap:11px; color:#f1e8fb; font-size:12px; }
    .hero-steps b { display:grid; place-items:center; flex:none; width:20px; height:20px; border-radius:50%; background:#ffffff26; font-size:10px; }
    .hero-steps strong { color:#fff; }
    .hero-notice { margin:14px 0 0 !important; color:#ffd9de !important; font-size:12px !important; }
    .hero-orb { position:absolute; z-index:0; pointer-events:none; border:1px solid #ffffff24; border-radius:50%; background:linear-gradient(145deg,#ffffff0f,#9cf4d914); }
    .orb-one { width:240px; height:240px; right:8%; top:-150px; }.orb-two { width:170px; height:170px; right:-30px; bottom:-100px; }
    .unlocks { padding:24px 26px 10px; border:1px solid #ffffffc8; border-radius:20px; background:linear-gradient(145deg,#ffffffbd,#ffffff70); box-shadow:0 14px 30px #44516b10,inset 0 1px #ffffffc8; }
    .unlocks header { display:flex; align-items:baseline; justify-content:space-between; gap:16px; margin-bottom:8px; }
    .unlocks h2 { margin:0; color:#352e49; font-size:17px; letter-spacing:-.02em; }
    .unlocks header p { margin:0; color:#958da6; font-size:12px; }
    .unlocks ul { margin:0; padding:0; list-style:none; }
    .unlocks li { display:grid; grid-template-columns:40px minmax(0,1fr) auto; align-items:center; gap:16px; padding:16px 0; }
    .unlocks li + li { border-top:1px solid #7c6a9b14; }
    .unlock-icon { display:grid; place-items:center; width:40px; height:40px; border-radius:12px; font-size:15px; }
    .tone-violet { color:#6850c2; background:#eee8ff; }.tone-rose { color:#b04c67; background:#fdeaf0; }.tone-amber { color:#a86b15; background:#fff0d7; }.tone-teal { color:#1f7f6a; background:#dcf5ec; }
    .unlocks strong { display:block; color:#3d3652; font-size:13px; }
    .unlocks small { display:block; margin-top:4px; color:#857d94; font-size:12px; line-height:1.5; }
    .unlocks em { padding:4px 10px; border-radius:20px; background:#f4f0f8; color:#958ba8; font-size:10px; font-style:normal; font-weight:650; white-space:nowrap; }
    .unlocks em.on { background:#e3f6ee; color:#2d8a65; }
    .reassurance { display:flex; align-items:flex-start; gap:10px; max-width:72ch; margin:0 4px; color:#8a829b; font-size:12px; line-height:1.6; }
    .reassurance fa-icon { margin-top:2px; color:#a89fc0; font-size:11px; }
    .privacy-page button { cursor:pointer; }
    .privacy-page button:disabled { cursor:default; opacity:.6; }
    @media(max-width:620px) { .access-hero { grid-template-columns:1fr; padding:24px 22px; gap:16px; }.hero-icon { width:44px; height:44px; }.unlocks { padding:18px 16px 6px; }.unlocks header { flex-direction:column; gap:4px; }.unlocks li { grid-template-columns:36px minmax(0,1fr); }.unlocks em { grid-column:2; justify-self:start; } }
  `]
})
export class PrivacyComponent {
  readonly faArrowRight = faArrowRight;
  readonly faCircleCheck = faCircleCheck;
  readonly faGear = faGear;
  readonly faLock = faLock;
  readonly faRotateLeft = faRotateLeft;
  readonly faShieldHalved = faShieldHalved;
  readonly state = signal<PermissionState>('checking');
  readonly checking = signal(false);
  readonly notice = signal('');
  readonly settingsOpened = signal(false);
  readonly unlocks = [
    { icon: faEnvelope, tone: 'violet', title: 'Mail attachments', detail: 'Measure attachments Mail has downloaded, before you decide what to remove.' },
    { icon: faTrashCan, tone: 'rose', title: 'Trash contents', detail: 'See what is already in the Trash and how much space it actually takes.' },
    { icon: faLock, tone: 'amber', title: 'Protected logs and caches', detail: 'Include system folders macOS otherwise keeps out of reach.' },
    { icon: faBoxArchive, tone: 'teal', title: 'Sandboxed app data', detail: 'Move an App Store app’s container to the Trash when you uninstall it.' }
  ];
  readonly lastCheckedAt = signal<number | null>(null);
  readonly granted = computed(() => this.state() === 'granted');
  readonly statusText = computed(() => this.state() === 'checking' ? 'Checking…' : this.granted() ? 'Granted' : 'Not granted');
  readonly lastChecked = computed(() => {
    const at = this.lastCheckedAt();
    return at === null ? 'not checked yet' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
  });

  constructor() { void this.checkAccess(); }

  async checkAccess(): Promise<void> {
    if (!window.electronAPI) { this.state.set('missing'); this.lastCheckedAt.set(Date.now()); return; }
    this.checking.set(true);
    this.state.set('checking');
    this.notice.set('');
    try {
      const result = await window.electronAPI.checkFullDiskAccess();
      this.state.set(result.granted ? 'granted' : 'missing');
      this.lastCheckedAt.set(Date.now());
    } catch {
      this.state.set('missing');
      this.notice.set('Could not check Full Disk Access. Please try again.');
    } finally { this.checking.set(false); }
  }

  async openSystemSettings(): Promise<void> {
    try {
      const result = await window.electronAPI?.openPrivacySettings();
      if (result?.opened) {
        this.settingsOpened.set(true);
      } else {
        this.notice.set('Open System Settings → Privacy & Security → Full Disk Access, then enable OpenClean.');
      }
    } catch { this.notice.set('Could not open System Settings. Open Privacy & Security → Full Disk Access manually.'); }
  }
}
