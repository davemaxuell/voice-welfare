# Guardian contact: a voice skill that messages the user's guardian

Status: voice registration, confirmed preview and optional SOLAPI SMS implemented on 2026-11-18. The default preview runs locally. The SOLAPI adapter was tested with mocked HTTP responses. A live SMS requires credentials, a registered sending number and explicit configuration. KakaoTalk and replies remain future work.

## Idea

A voice command such as "보호자한테 연락해줘" that sends the user's guardian a short message. The user may be stuck on a form, at a login or identity-verification handoff, or in trouble. It fits the existing pattern of asking aloud and then acting once.

## Recommendation

- Build it as a guardian-contact skill behind a small sender interface, so the channel can change without touching the skill.
- First sender: a mock that shows the message that would be sent, like the mock application site. This is enough for the demo.
- First real sender: SMS to the guardian's phone number through a Korean SMS provider. The guardian installs nothing.
- Later sender: KakaoTalk, only if the guardian links the app and the review passes.
- Phone calls are out of scope. They are a separate and harder problem.

## Channel findings (web search 2026-11-18)

### KakaoTalk: hard for a personal project

- **Message API (to friends).** It reaches only friends who use the same app. The sender and the recipient must both be linked to the app and consent to the friends-list and send-message items. Users pick the recipients, and the docs warn that automatic sending risks being rejected in review. It needs a business-app switch and a review. Before approval, only app members can be messaged, up to 30 messages a day per app.
  - https://developers.kakao.com/docs/latest/en/kakaotalk-message/rest-api
  - https://devtalk.kakao.com/t/checklist-to-use-the-messaging-api-and-the-retrieving-list-of-friends-api/118992
- **Kakao Link (share).** It needs no review and can reach friends who have not linked the app. Not confirmed: whether the user can send without tapping through the KakaoTalk UI. If not, it breaks voice-only use.
- **알림톡 (Alimtalk).** It needs a business channel, an official dealer, approved templates and per-message fees. It is for notifications, not personal help messages. The details come from vendor blogs, not Kakao's own pages, so check them before relying on them.
  - https://blog.bizgo.io/howto/alimtalk-guide/
- Net: an agent that sends KakaoTalk messages to a guardian by itself is not realistically available to a personal project.

### SMS: the practical first channel

Checked against one provider, Solapi.

- Korea requires the sending number to be pre-registered. Unregistered numbers are blocked.
- Registration needs documents such as a telecom-service certificate. Review takes about 1–3 business days.
- A personal account can register up to 5 numbers. Business verification raises the limits.
- Since the September 2026 update, registration also needs an extra ARS verification, and verification is valid for 2 years.
- SMS is limited to 90 bytes. Longer text becomes LMS automatically. Korean characters are about 2 bytes each, so keep the SMS template around 40 characters. The conversion is an estimate, not from the source.
  - https://solapi.com/start
  - https://solapi.com/updates/updates-202609
  - https://solapi.com/guides/sms-howtosend

## Design fit with the existing rules

- **Storage.** The guardian's name and number go in the personal vault (`personal/`), set up by voice. The user must confirm the guardian agreed to be contacted, since the number is third-party personal data.
- **Confirm aloud, then act.** Read the exact text and recipient, wait for a go word, then send once. If the screen or the text changes before the go word, ask again.
- **Gates.** The command waits for consent and the stop gates, as decided for vault commands. "멈춰" must cancel a pending send.
- **Message text.** Code builds it from a template, not the model. By default it has no screen text and no personal values, because it tells the guardian what the user is doing. Sharing more (site name, what the user was doing) needs the user's explicit OK.
- **Honest reporting.** Say "보냈어요" only when the provider accepts the message. Never claim the guardian read it. If sending fails, say so and offer to retry.
- **Emergencies.** The skill must not present itself as a replacement for 119.
- **Sender identity.** The guardian sees the number the service registered, not the user's own phone. The first line should say who the message is for, for example "청음 사용자 ○○님이 도움을 요청했어요". For the demo, one registered number is enough. A shipped version needs a service number.
- **Tests.** Use the `http_mock` fixture and a fake sender. Tests must never send a real message.

## Open questions

1. Is this mainly for emergencies, or for help during a task such as a form or a verification handoff? The answer changes the trigger phrases and the message content.
2. Do the guardians already use KakaoTalk, or is SMS fine?
3. Domestic per-message price. Not found in the search; check the provider's price page. NHN Cloud and other providers may differ.
4. How to register a personal mobile number as the sender. The exact steps were not found; check the provider's guide.
5. Placement in the code. Not decided. It should be injected like the vault, not imported by `agents/web`.
6. Whether the guardian can reply and the user hears it read aloud. Out of scope for the first version.
