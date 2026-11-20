# S2 background-tab screenshot (2026-11-18, playwright 1.65.2, scratch profiles, 100% scaling only)

chromium headed: 160 ms, input mask (0,0,0), paragraph mask (0,0,0), cursor spot white (hidden by style=), front tab stays visible, size 1086x766
chrome headed (channel chrome, scratch profile): 172 ms, same pixels, size 1086x710
chromium headless: 89 ms, same pixels, 1100x860

- page.screenshot(mask=[locators], mask_color, style="#__cheongeum_cursor{display:none!important}", scale="css") works on a background tab without bring_to_front.
- Pillow is not a project dependency and is not needed for web capture.
- Not tested: 125%/150% display scaling (owner's PC setting), minimized Chrome window.
