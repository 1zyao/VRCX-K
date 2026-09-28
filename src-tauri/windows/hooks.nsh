; VRCX-K NSIS installer hooks.
;
; ⚠ ONLY `NSIS_HOOK_POSTUNINSTALL` IS DEFINED HERE. Tauri includes this file into its own
; template, so any macro we add REPLACES nothing but is inserted at a fixed point — see
; `docs`-level reasoning below before adding another one.
;
; # Why a hook at all, when Tauri's template already deletes the deep-link key
;
; The upstream template's uninstall section already has a guarded delete:
;
;     ReadRegStr $R7 SHCTX "Software\Classes\<scheme>\shell\open\command" ""
;     ${If} $R7 == "<our exe> "%1""
;       DeleteRegKey SHCTX "Software\Classes\<scheme>"
;     ${EndIf}
;
; That guard is exact-command-string equality, so four real cases slip past it and leave the
; key behind — all four are recorded in `docs/deep-link-decisions.md` §4.1:
;
;   1. the app was once installed to a DIFFERENT directory (upgrade, user-chosen path), so
;      `$INSTDIR` no longer matches the stored command;
;   2. the key was written by the app's own runtime `register` rather than by the installer;
;   3. a user or a security tool edited `shell\open\command`;
;   4. the declared scheme name changed, so nothing declares the old one any more.
;
; # ⚠ Why this is a bare DeleteRegKey on ONE name, and not a scan
;
; The bound is the point. `vrcxk` is the ONLY scheme this build declares
; (`tauri.conf.json` → `plugins.deep-link.desktop.schemes`, pinned by
; `the_uninstaller_cleans_up_every_declared_scheme` in `src-tauri/src/lib.rs`), so a key under
; that exact name is ours to remove: our installer wrote it, or our app's runtime registration
; did.
;
; What this deliberately does NOT do:
;   - it does not enumerate or pattern-match class keys ("vrcxk*" and friends): a class key
;     that is not exactly a declared name is not ours to delete, and deleting a foreign
;     handler is strictly worse than leaving a stale one of ours (an existing class key
;     cannot be restored — §4.2 of the decision record);
;   - it does not try to restore an overwritten value. That is impossible by construction
;     (`unregister` is a `remove_tree`), which is why the runtime gate refuses to overwrite a
;     foreign key in the first place.
;
; ⚠ MSI IS NOT COVERED HERE. The WiX template registers the scheme under `Root="HKLM"`
; (machine-wide, per-machine installs) while this NSIS hook — like the rest of the NSIS
; template — uses `SHCTX` (per-user installs ⇒ HKCU). Both installers ship
; (`bundle.targets = "all"`, the owner's decision), so MSI uninstall cleanliness is a separate
; question that must be verified on a real machine; see `docs/deep-link-decisions.md` §7.2.

!macro NSIS_HOOK_POSTUNINSTALL
  ; Keep this in lockstep with plugins.deep-link.desktop.schemes in tauri.conf.json — the
  ; packaging test asserts every declared scheme appears here as a DeleteRegKey.
  DeleteRegKey HKCU "Software\Classes\vrcxk"
!macroend
