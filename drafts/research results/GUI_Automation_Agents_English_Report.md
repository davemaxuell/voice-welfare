# Technical Summary of GUI Automation Agents

*How agents work in the background without taking over your active window*

**Technical report / Computer-use agents**  
Compiled for Dave | 17 November 2026

> **Core idea.** The agent’s computer does not have to be your computer. The model decides what to do; an executor applies the action inside a designated browser, virtual display, or cloud computer.

This report consolidates the English explanation from this conversation, including execution modes, vendor approaches, operating-system restrictions, implementation examples, security, and a recommended service architecture.

## Contents

- [1. The main ways to execute tasks invisibly](#1-the-main-ways-to-execute-tasks-invisibly)
- [2. Clicks and typing without moving your mouse](#2-clicks-and-typing-without-moving-your-mouse)
- [3. Does a vision-based agent need a visible screen?](#3-does-a-vision-based-agent-need-a-visible-screen)
- [4. The complete execution pipeline](#4-the-complete-execution-pipeline)
- [5. What the major services publicly document](#5-what-the-major-services-publicly-document)
- [6. Operating-system restrictions](#6-operating-system-restrictions)
- [7. Implementation examples](#7-implementation-examples)
- [8. Isolation, credentials, and security](#8-isolation-credentials-and-security)
- [9. Scheduling, persistence, and live previews](#9-scheduling-persistence-and-live-previews)
- [10. Cost, scaling, and recommended architecture](#10-cost-scaling-and-recommended-architecture)
- [Source references](#source-references)

Select a contents entry to jump to that section.

Scope note: source links are carried over from the English report in this conversation; this compilation is not a new source-verification exercise. Code examples are illustrative and have not been executed. Vendor capabilities and APIs can change.

## 1. The main ways to execute tasks invisibly

**The central idea is that the agent’s computer does not have to be your computer.** A service can run a browser or desktop in the cloud, send actions to it, and receive screenshots without opening anything on your screen. OpenAI Dots and Grok Bot document cloud-computer execution. Another approach is a local or remote headless browser, which runs without displaying its interface. [\[1\]](#ref_1), [\[8\]](#ref_8), [\[17\]](#ref_17)

The important distinction is between **the AI model deciding what to do** and **the execution environment carrying out those decisions**. Claude’s computer-use interface provides screenshot, mouse, and keyboard capabilities; the surrounding application supplies the environment and executes the interaction loop. [\[3\]](#ref_3)

### A. Headless browsers: a browser without a visible window

A headless browser still loads websites and runs browser functionality, but its interface is not displayed on a monitor. Modern Chrome’s headless mode uses the same underlying browser implementation as its visible mode; Chrome creates platform windows without displaying them. [\[2\]](#ref_2)

```text
Agent decides on an action
          |
Browser automation tool sends the command
          |
Headless browser performs the action
          |
Page state or screenshot returns to the agent
```

The browser may run on your machine or a server. In either case, there is no requirement for a visible browser window. OpenAI’s public computer-use sample includes a headless execution option and supports model-requested computer actions and Playwright-based browser scripting. [\[4\]](#ref_4)

**Use this approach primarily for website interaction.**

### B. Virtual displays: a graphical desktop rendered off-screen

Some applications require a graphical display server even when nobody needs to watch them. On Linux, **Xvfb**, short for X virtual framebuffer, supplies an X11 display in memory. Applications can draw into that display without a physical monitor or input device. [\[5\]](#ref_5)

| **Your physical desktop**  | **Agent’s virtual display**     |
|----------------------------|---------------------------------|
| You use your applications. | The agent opens applications.   |
| You control your pointer.  | The agent controls its pointer. |
| You see your monitor.      | Software captures its screen.   |

A browser running this way can be headed, meaning it behaves as a normal graphical application, while remaining invisible on your physical desktop. Playwright documents using Xvfb for headed browser execution on Linux infrastructure. [\[6\]](#ref_6)

> **Key distinction.** A headless browser does not display its interface. A virtual display lets a graphical application draw its interface onto a software-provided display.

For desktop-agent experimentation, Anthropic provides a reference implementation that runs a Linux desktop in Docker using X11 and VNC. [\[7\]](#ref_7)

### C. Cloud computers: the agent works on another machine

A cloud computer provides the agent with its own browser, filesystem, and execution environment. OpenAI documents that a dot has a computer and browser in the cloud. Grok Bot documents a persistent cloud computer shared by the user’s Bots. These are separate from the user’s active local desktop. [\[8\]](#ref_8), [\[17\]](#ref_17)

```text
Your device
    |  Task instructions and progress updates
    v
Agent service
    |  Model decisions and tool calls
    v
Cloud computer
    +-- Browser
    +-- Files
    +-- Terminal
    +-- Application environment
```

**Cloud execution and headless execution are different properties.** A cloud computer can run a headless browser or a full graphical desktop. “Remote” describes where the work happens; “headless” describes whether the browser displays its interface.

### D. Direct app integrations: sometimes there is no clicking

An agent may use a connected application or API rather than operate its GUI. Grok Bot’s documentation describes choosing connected apps for supported operations and using the cloud browser for websites without an appropriate integration. OpenAI’s public sample also illustrates the role of structured tools alongside computer control. [\[9\]](#ref_9), [\[4\]](#ref_4)

A task appearing to happen “in the background” therefore does not necessarily involve a hidden mouse or browser.

## 2. Clicks and typing without moving your mouse

### Browser-level control

Browser automation can send events directly to a browser session instead of controlling your operating system’s physical pointer. The **Chrome DevTools Protocol (CDP)** exposes methods such as the following. [\[10\]](#ref_10)

```text
Input.dispatchMouseEvent
Input.dispatchKeyEvent
Input.insertText
```

These methods target the browser being controlled. An agent service can connect to a cloud browser and issue commands there. Browserbase exposes a CDP connection endpoint for its browser sessions, allowing compatible automation clients to connect remotely. [\[10\]](#ref_10), [\[11\]](#ref_11)

```text
Your mouse       --> Your local desktop
Agent commands   --> Its designated browser session
```

Stagehand is one documented example of an AI-oriented browser driver that communicates through CDP. The documentation cited in the English report states that it does not depend on Playwright or Puppeteer. [\[12\]](#ref_12)

### Desktop-level control

For applications outside a browser, an executor can use desktop automation tools. **PyAutoGUI** supports moving the mouse, clicking, typing, and capturing screenshots on Windows, macOS, and Linux. It operates against a desktop environment rather than supplying a desktop environment itself. [\[13\]](#ref_13)

> **Important.** PyAutoGUI is an input-and-screenshot tool, not a virtualization system.

To avoid interfering with the user, the design should place the controlled desktop in a separate environment, such as a dedicated VM or a Linux virtual display. Anthropic recommends a dedicated VM or container with minimal privileges for computer-use deployments. [\[3\]](#ref_3)

## 3. Does a vision-based agent need a visible screen?

**It needs an image of the interface, not necessarily a physical monitor or a window visible to the user.** A screenshot-driven computer-use loop needs a source of screen pixels. That source may be a remote desktop, a virtual display, or a browser session capable of returning screenshots. Anthropic’s containerized desktop demo and OpenAI’s browser-focused sample illustrate these separate execution patterns. [\[7\]](#ref_7), [\[4\]](#ref_4)

| **Requirement**                                              | **Necessary?** |
|--------------------------------------------------------------|----------------|
| The interface must produce an observation the agent can use. | Yes.           |
| The interface must appear on the user’s physical monitor.    | No.            |

The earlier report’s wording that a vision agent always needs a separate “virtual GUI” was too broad. **A headless browser does not need a full desktop environment merely because the agent uses screenshots.** OpenAI’s sample demonstrates computer actions against a browser session with a headless option. [\[4\]](#ref_4)

## 4. The complete execution pipeline

A practical computer-use service separates the model, the executor, and the environment. Anthropic’s reference implementation exposes this structure through an agent loop, computer-use tools, and a containerized desktop. [\[7\]](#ref_7)

A reference architecture for your service would be:

```text
User instruction
      |
Task controller
      |
Acquire browser or desktop environment
      |
Observe current state
      |
Model proposes the next action
      |
Permission and policy checks
      |
Executor performs the action
      |
Capture the result and verify progress
      |
Continue, request approval, recover, or finish
```

### Example task: download the latest invoice

Open the billing website; inspect the current page; identify the invoices section; click the relevant control; observe the resulting page; select the correct invoice; download the file; verify that it exists; and return the result.

This is an illustrative workflow, not a description of a particular vendor’s private implementation.

> **Feedback loop.** Observe → decide → act → observe again.

Running that loop remotely makes it independent of the user’s local foreground window. Keeping it running across pauses or failures requires additional orchestration and state management; it is not something headless mode provides by itself.

## 5. What the major services publicly document

### OpenAI Dots

OpenAI confirms that dots have their own cloud computers and browsers and can work with connected applications. Dots can also connect to other computers when authorized. [\[14\]](#ref_14), [\[8\]](#ref_8)

For a **cloud-computer task**, execution happens in the dot’s environment. For a **connected-computer task**, execution depends on the capabilities and availability of that connected device.

The cloud environment does not automatically inherit the user’s local VPN, browser sign-ins, or device policies. These disclosures establish where execution happens. They do not establish that Dots internally uses a particular third-party library such as PyAutoGUI or Playwright. [\[15\]](#ref_15)

### OpenAI’s public computer-use sample

The sample described in the English report is a TypeScript application with a runner, an operator console, browser sessions, and replay artifacts. It supports model-requested computer actions and a Playwright JavaScript execution environment, and provides a headless option. [\[4\]](#ref_4)

**This is a public implementation example, not proof that OpenAI’s commercial products use exactly the same runtime.**

### Anthropic Claude Computer Use

Claude’s computer-use tool provides screenshot, mouse, and keyboard interaction. In an API-based deployment, the surrounding application must supply and operate the computer environment. [\[3\]](#ref_3)

Anthropic’s reference demo uses a Linux desktop in Docker with X11 and VNC. It is a useful starting point for studying how a graphical environment can run separately from the user’s desktop. [\[7\]](#ref_7)

### Anthropic Managed Agents

Anthropic describes a separation between the **harness**, which coordinates model execution, and the **sandbox**, where agent code runs. Session history can live outside the sandbox, and supported credentials can be attached by a proxy rather than exposed directly to sandboxed code. Durable background execution therefore involves more than maintaining a browser process. [\[16\]](#ref_16), [\[21\]](#ref_21)

### Grok Bot

**Correction retained from the English report:** Grok Bot’s cloud execution environment is publicly documented. Its documentation states that Bots share a persistent cloud computer containing a browser, filesystem, and terminal. Their cloud work is therefore not performed by taking over the user’s local desktop. This does not, by itself, identify the underlying mouse-control library or virtualization stack. [\[17\]](#ref_17), [\[9\]](#ref_9)

### Browserbase and Stagehand

Browserbase provides hosted Chromium sessions with remote connection endpoints, session-persistence options, and observability. Its Live View allows a user to watch or intervene in a remote session. [\[11\]](#ref_11), [\[22\]](#ref_22)

Stagehand supplies AI-assisted browser primitives alongside deterministic browser controls. The documented architecture uses CDP and an in-browser runtime. [\[12\]](#ref_12)

### Skyvern and browser-use

Skyvern provides an open-source system for automating browser workflows with AI. Browser-use provides a browser-agent library and hosted options, allowing a distinction between embedding the library in your own product and using a hosted service. [\[18\]](#ref_18), [\[19\]](#ref_19)

These are publicly available building blocks, not evidence that OpenAI, Anthropic, or xAI use them internally.

## 6. Operating-system restrictions

### Windows

OpenAI’s documentation states that its Windows Computer Use operates on the **active desktop** and cannot work independently in the background while the user continues using the same Windows session. It recommends a Windows VM when the user needs separation from the main desktop. [\[20\]](#ref_20)

This is a documented restriction of that product’s control mechanism, not a claim that every Windows automation API requires foreground interaction. For your architecture, a dedicated Windows VM is a sensible default when a task genuinely requires Windows desktop applications.

### macOS

OpenAI documents scoped background computer-use tasks on macOS, along with Screen Recording and Accessibility permissions. It also documents a separate, explicitly enabled **Locked use** feature with additional authorization and safeguards. [\[20\]](#ref_20)

**Those product-specific capabilities should not be generalized to every macOS automation script.** Accessibility permission alone is not evidence that arbitrary software can operate every application invisibly or while the computer is locked.

### Linux

Linux provides a straightforward virtual-display option through Xvfb. A display can exist in memory without physical display hardware, allowing graphical applications to run off-screen. [\[5\]](#ref_5)

For a service design, keep each tenant’s desktop workload in an appropriately isolated environment rather than treating separate display numbers as a sufficient security boundary.

## 7. Implementation examples

### Example A: a headed browser inside a virtual display

The following example demonstrates **a real graphical browser running without appearing on your monitor**. It is an execution demonstration, not a complete AI agent: there is no LLM deciding the actions. The code has not been executed here.

The version pins below are retained from the earlier report. Verify image availability and keep the installed Playwright package version aligned with the browser image before deployment.

#### Dockerfile

```dockerfile
FROM mcr.microsoft.com/playwright/python:v1.61.0-noble

# Match the Python package to the browser image version.
RUN pip install --no-cache-dir playwright==1.61.0

WORKDIR /app
COPY agent.py /app/agent.py

# Run the graphical browser inside an off-screen X11 display.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x1024x24", \
     "python", "/app/agent.py"]
```

Playwright’s image includes browsers and their system dependencies, but the Playwright package itself must be installed separately. Its documentation warns that the default image is intended for testing and development, not as a hardened environment for visiting untrusted websites. [\[6\]](#ref_6)

#### agent.py

```python
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    output_dir = Path("/app/output")
    output_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        # This is a headed browser. Xvfb makes it off-screen.
        browser = playwright.chromium.launch(headless=False)
        try:
            page = browser.new_page(
                viewport={"width": 1280, "height": 1024}
            )
            # A self-contained page avoids external websites.
            page.set_content("""
                <button onclick="
                    document.querySelector('#status').textContent = 'Done'
                ">
                    Run task
                </button>
                <p id="status">Waiting</p>
            """)
            button = page.get_by_role("button", name="Run task")
            button.hover()
            button.click()
            assert page.locator("#status").inner_text() == "Done"
            page.screenshot(path=str(output_dir / "result.png"))
            print("Task completed. Screenshot: output/result.png")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
```

#### Build and run from a shell

```bash
mkdir -p output

docker build -t background-gui-demo .

docker run --rm --init --shm-size=1g \
  -v "$PWD/output:/app/output" \
  background-gui-demo
```

For untrusted browsing, do not treat this development example as production isolation. Playwright recommends a separate browser user and an appropriate seccomp configuration for sandboxed browsing. [\[6\]](#ref_6)

### Example B: PyAutoGUI connected to a virtual display

A minimal Linux example is:

```python
from pyvirtualdisplay import Display

# Requires Xvfb and a working screenshot backend on the host.
with Display(visible=False, size=(1280, 1024)):
    # Import after the virtual display has been initialized.
    import pyautogui

    # Launch the target GUI application in this environment first.
    # Without an application, the screen may show an empty desktop.
    pyautogui.screenshot().save("screen.png")
    pyautogui.click(100, 200)
```

The virtual display supplies the screen, while PyAutoGUI supplies input and screenshot operations. PyAutoGUI’s documented capabilities include mouse movement, clicks, keyboard input, and screenshots. [\[13\]](#ref_13)

## 8. Isolation, credentials, and security

**Not showing a window is not a security boundary.** Background agents still require explicit limits on what they can access and change.

Anthropic recommends minimal-privilege environments, restricted network access, limited exposure to sensitive data, and human confirmation for consequential actions. These controls reduce risks; they do not eliminate them. [\[3\]](#ref_3)

| **Control**                            | **Purpose**                                                       |
|----------------------------------------|-------------------------------------------------------------------|
| Tenant-specific execution environments | Prevent unrelated users’ workloads from sharing accessible state. |
| Scoped credentials                     | Limit which accounts and operations a task can access.            |
| Network restrictions                   | Constrain destinations available to the worker.                   |
| Approval checkpoints                   | Pause before consequential or irreversible actions.               |
| Action logs and screenshots            | Make failures and unexpected behavior inspectable.                |
| Cancellation and resource limits       | Stop runaway or stuck tasks.                                      |

A useful pattern is keeping credentials outside agent-controlled code when possible. Anthropic documents using an external proxy to attach credentials for supported API and MCP operations. This is narrower than a guarantee that every browser login can be kept secret from its execution environment. [\[16\]](#ref_16)

## 9. Scheduling, persistence, and live previews

### Background execution is not the same as durable execution

A hidden browser answers: **“Can this run without displaying a window?”** A durable task system must also answer: **“What happens when the worker crashes, the browser closes, authentication expires, or the task needs human approval?”**

Anthropic Managed Agents documents long-running sessions with server-side history and state, illustrating this separate infrastructure layer. [\[21\]](#ref_21)

For your service, use a task controller that records progress outside the browser or desktop worker:

```text
Task database / queue
          |
Worker acquires the task
          |
Browser or desktop environment
          |
Actions, observations, and checkpoints
          |
Result, approval request, retry, or failure
```

A retry policy should distinguish between safe repeatable actions and actions that could create duplicates. Reopening a page is not equivalent to submitting a payment again.

### Authentication persistence

Browserbase documents reusable contexts that preserve browser state across sessions. Its session model otherwise starts fresh unless persistence is explicitly enabled. [\[11\]](#ref_11)

For a multi-user service, bind each saved context to the correct user and account, encrypt stored state, and provide explicit revocation rather than reuse one shared browser profile.

### Live preview

A remote environment can still be observable. Browserbase provides Live View and session replay, while Anthropic’s desktop demo uses VNC for viewing its containerized desktop. [\[22\]](#ref_22), [\[7\]](#ref_7)

**Watching the environment is optional; the environment does not depend on the user continuously watching it.**

## 10. Cost, scaling, and recommended architecture

Rather than assuming that “headless” automatically means inexpensive, measure the cost of each completed task:

```text
Task cost =
    model inference
  + browser or desktop runtime
  + storage and observability
  + network usage
  + retries and recovery
```

For your agent service, the recommended starting architecture is:

```text
User interface
      |
Task API + authentication
      |
Task controller + persistent state
      |
Agent loop
      +-- Connected app/API tools
      +-- Browser automation worker
      +-- Desktop worker when necessary
      |
Verification + approvals + audit records
      |
Result delivery
```

**For web workflows**, start with a browser-focused execution environment. Playwright offers deterministic browser control; Stagehand or browser-use can supply higher-level agent-oriented functionality; Browserbase is an option for hosted browser infrastructure. [\[4\]](#ref_4), [\[12\]](#ref_12), [\[19\]](#ref_19), [\[11\]](#ref_11)

**For desktop workflows**, begin with an isolated environment rather than the user’s main desktop. Anthropic’s containerized Linux computer-use demo is a concrete reference to study. For Windows applications, a dedicated Windows VM provides separation from the user’s active session. [\[7\]](#ref_7), [\[20\]](#ref_20)

**For production**, add persistent task state, credential boundaries, approval handling, cancellation, and observability before expanding to unattended consequential actions.

> **Bottom line.** These agents do not need to make your active window invisible. They can perform the work in a different browser session, virtual display, or cloud computer, or avoid GUI interaction entirely through connected tools. The model chooses actions; the executor applies them; the execution environment determines whether anything appears on your screen.

## Source references

Numbered citations in the report link to the entries below. Select a source title to open its documentation or repository. Sources were carried over from the preceding English report and were not independently re-verified during document compilation.

<a id="ref_1"></a>

**\[1\] OpenAI Help Center.** [Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)

<a id="ref_2"></a>

**\[2\] Chrome for Developers.** [Chrome Headless mode](https://developer.chrome.com/docs/automation-and-testing/headless)

<a id="ref_3"></a>

**\[3\] Claude Platform.** [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)

<a id="ref_4"></a>

**\[4\] OpenAI / GitHub.** [Computer-use sample application](https://github.com/openai/openai-cua-sample-app)

<a id="ref_5"></a>

**\[5\] X.Org.** [Xvfb manual](https://www.x.org/archive/X11R7.0/doc/html/Xvfb.1.html)

<a id="ref_6"></a>

**\[6\] Playwright.** [Docker documentation for Python](https://playwright.dev/python/docs/docker)

<a id="ref_7"></a>

**\[7\] Anthropic / GitHub.** [Claude quickstarts: computer-use demo](https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo)

<a id="ref_8"></a>

**\[8\] ChatGPT Learn.** [Dots documentation](https://learn.chatgpt.com/docs/dots)

<a id="ref_9"></a>

**\[9\] xAI documentation.** [Grok Bot: computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)

<a id="ref_10"></a>

**\[10\] Chrome DevTools Protocol.** [Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/)

<a id="ref_11"></a>

**\[11\] Browserbase.** [What is a Browserbase browser?](https://www.browserbase.com/blog/what-is-a-browserbase-browser)

<a id="ref_12"></a>

**\[12\] Stagehand.** [Introduction, version 4 documentation](https://docs.stagehand.dev/v4/first-steps/introduction)

<a id="ref_13"></a>

**\[13\] PyAutoGUI.** [PyAutoGUI documentation](https://pyautogui.readthedocs.io/en/latest/)

<a id="ref_14"></a>

**\[14\] OpenAI.** [Introducing Dots](https://openai.com/index/introducing-dots/)

<a id="ref_15"></a>

**\[15\] OpenAI Help Center.** [Managing dots in ChatGPT workspaces](https://help.openai.com/en/articles/20001554-managing-dots-in-chatgpt-workspaces)

<a id="ref_16"></a>

**\[16\] Claude.** [Self-hosted Claude Managed Agents](https://claude.com/resources/articles/self-hosted-claude-managed-agents)

<a id="ref_17"></a>

**\[17\] xAI documentation.** [Grok Bot overview](https://docs.x.ai/grok-bot/overview)

<a id="ref_18"></a>

**\[18\] Skyvern / GitHub.** [Skyvern repository](https://github.com/Skyvern-AI/skyvern)

<a id="ref_19"></a>

**\[19\] browser-use / GitHub.** [browser-use repository](https://github.com/browser-use/browser-use)

<a id="ref_20"></a>

**\[20\] ChatGPT Learn.** [Computer Use](https://learn.chatgpt.com/docs/computer-use)

<a id="ref_21"></a>

**\[21\] Claude Platform.** [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)

<a id="ref_22"></a>

**\[22\] Browserbase.** [Observability: Live View and session replay](https://www.browserbase.com/observability)
