
const { CallAutomationClient, RecognizeInputType } = require("@azure/communication-call-automation");

const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING;
const PUBLIC_CALLBACK_URI   = process.env.PUBLIC_CALLBACK_URI;
const SALES_NUMBER          = process.env.SALES_NUMBER;
const SUPPORT_NUMBER        = process.env.SUPPORT_NUMBER;
const TTS_VOICE             = process.env.TTS_VOICE || "en-IN-NeerjaNeural";
const SPEECH_LOCALE         = process.env.SPEECH_LOCALE || "en-IN";

const caClient = new CallAutomationClient(ACS_CONNECTION_STRING);

function toArray(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  try { if (typeof body === "string") return JSON.parse(body); } catch {}
  return [body];
}

function isEventGridEvent(e) {
  return e && (e.eventType || e.topic) && e.data;
}
function isSubscriptionValidation(e) {
  return e && e.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent";
}
function isIncomingCallEG(e) {
  return e && e.eventType === "Microsoft.Communication.IncomingCall";
}
function isCloudEvent(e) {
  return e && e.type && e.source && e.data;
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") {
      context.res = { status: 200 };
      return;
    }

    const events = toArray(req.body);
    if (events.length === 0) {
      context.res = { status: 200 };
      return;
    }

    if (isEventGridEvent(events[0])) {
      for (const eg of events) {
        if (isSubscriptionValidation(eg)) {
          const code = eg.data && eg.data.validationCode;
          context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: { validationResponse: code }
          };
          return;
        }
        if (isIncomingCallEG(eg)) {
          const incomingCallContext = eg.data && eg.data.incomingCallContext;
          await caClient.answerCall(incomingCallContext, { callbackUrl: PUBLIC_CALLBACK_URI });
        }
      }
      context.res = { status: 200 };
      return;
    }

    if (isCloudEvent(events[0])) {
      for (const ce of events) {
        const type = ce.type;
        const data = ce.data || {};
        const callConnectionId = data.callConnectionId;
        const callConnection = callConnectionId ? caClient.getCallConnection(callConnectionId) : null;
        const media = callConnection ? callConnection.getCallMedia() : null;

        switch (type) {
          case "Microsoft.Communication.CallConnected": {
            await media.playToAll({ text: "Welcome to Contoso. Please briefly say your reason for calling after the tone.", voiceName: TTS_VOICE });
            await media.startRecognizing({ inputType: RecognizeInputType.Speech, endSilenceTimeoutInMs: 1200, speechLocale: SPEECH_LOCALE, interruptPrompt: true });
            break;
          }
          case "Microsoft.Communication.RecognizeCompleted": {
            const r = data.recognizeResult || {};
            const inputType = (r.recognizeInputType || r.kind || "").toString().toLowerCase();
            if (inputType.includes("speech")) {
              const transcript = (r.speechResult && r.speechResult.speechText) || "";
              const heard = transcript.trim().length > 0 ? `You said: ${transcript}.` : "I didn't catch that.";
              await media.playToAll({ text: `${heard} For Sales, press 1. For Support, press 2.`, voiceName: TTS_VOICE });
              await media.startRecognizing({ inputType: RecognizeInputType.Dtmf, dtmfOptions: { interToneTimeoutInMs: 5000, maxTonesToCollect: 1, stopTones: [] }, interruptPrompt: true });
            } else if (inputType.includes("dtmf")) {
              const tones = (r.dtmfResult && r.dtmfResult.tones) || [];
              const t = (tones[0] || "").toString().toLowerCase();
              const one = t === "one" || t === "1";
              const two = t === "two" || t === "2";
              if (one) {
                await media.playToAll({ text: "Connecting you to Sales.", voiceName: TTS_VOICE });
                await transferToNumber(callConnection, SALES_NUMBER);
              } else if (two) {
                await media.playToAll({ text: "Connecting you to Support.", voiceName: TTS_VOICE });
                await transferToNumber(callConnection, SUPPORT_NUMBER);
              } else {
                await media.playToAll({ text: "Invalid selection. For Sales, press 1. For Support, press 2.", voiceName: TTS_VOICE });
                await media.startRecognizing({ inputType: RecognizeInputType.Dtmf, dtmfOptions: { interToneTimeoutInMs: 5000, maxTonesToCollect: 1 }, interruptPrompt: true });
              }
            }
            break;
          }
          case "Microsoft.Communication.RecognizeFailed": {
            await media.playToAll({ text: "Sorry, I didn't get that. For Sales, press 1. For Support, press 2.", voiceName: TTS_VOICE });
            await media.startRecognizing({ inputType: RecognizeInputType.Dtmf, dtmfOptions: { interToneTimeoutInMs: 5000, maxTonesToCollect: 1 }, interruptPrompt: true });
            break;
          }
        }
      }
      context.res = { status: 200 };
      return;
    }

    context.res = { status: 200 };
  } catch (err) {
    context.log.error("IVR error:", err);
    context.res = { status: 200 };
  }
};

async function transferToNumber(callConnection, targetE164) {
  if (!callConnection || !targetE164) return;
  await callConnection.transferCallToParticipant({ targetParticipant: { phoneNumber: targetE164 } });
}
