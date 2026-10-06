const axios = require("axios");

async function sendOtpViaMsg91(phone, otp) {
  // Mobile needs to involve country code (e.g. 91xxxxxxxxxx). User should pass it formatted.
  // Msg91 expects numbers without '+', so we remove non-digits.
  let cleanPhone = String(phone).replace(/\D/g, "");

  // If a raw 10 digit Indian number is sent, auto-append "91" so MSG91 doesn't
  // misinterpret the first few digits as a blocked country code (like Qatar's 974).
  if (cleanPhone.length === 10) {
    cleanPhone = "91" + cleanPhone;
  }

  // msg91 single-message WhatsApp endpoint (supports standard components array format)
  const url = "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/";

  // The otp_vendor template was recreated under the new WhatsApp number
  // (919446688082) using Meta's current, much stricter Authentication
  // category format — fixed "XXXXXX is your verification code" body with
  // just ONE variable (the code itself), not the old 5-variable custom
  // wording Meta no longer allows for Authentication templates.
  const payload = {
    integrated_number: process.env.MSG91_WHATSAPP_NUMBER,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "template",
      template: {
        name: process.env.MSG91_WHATSAPP_TEMPLATE_NAME,
        language: {
          code: process.env.MSG91_WHATSAPP_LANGUAGE || "en_US"
        },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: otp }
            ]
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [
              { type: "text", text: otp }
            ]
          }
        ]
      }
    }
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        authkey: process.env.MSG91_EMAIL_AUTHKEY,
        "Content-Type": "application/json"
      }
    });
    console.log("MSG91 WhatsApp Success:", response.data);
    return response.data;
  } catch (err) {
    console.error("MSG91 WhatsApp Error:", err.response?.data || err.message);
    throw new Error("Failed to send WhatsApp OTP");
  }
}

// Sends a pre-approved WhatsApp "utility" template with a single named
// {{recipient_name}} variable — one template per canned reminder reason
// (currently just missing documents), each with fixed wording that matches
// exactly what the
// admin panel's DRIVER_ISSUE_REMINDER_CONTENT says. Deliberately NOT a
// single generic "any message" template: WhatsApp's review flagged an
// earlier version of this with a free-text second variable as Marketing
// (requires recipient opt-in nobody has given), because a template whose
// body can say anything doesn't read as a genuine fixed-purpose utility
// message. An admin's own freely-typed message therefore can't go out as a
// WhatsApp template at all — only the canned reminders can, via their own
// approved templateName. Until a given reminder's template env var is set
// and approved, this is a silent no-op, so the in-app notification still
// goes out either way.
async function sendWhatsAppTemplate(phone, templateName, variables) {
  if (!templateName) {
    console.warn("No WhatsApp template configured for this reminder — skipping (in-app notification still sent)");
    return null;
  }

  let cleanPhone = String(phone).replace(/\D/g, "");
  if (cleanPhone.length === 10) {
    cleanPhone = "91" + cleanPhone;
  }

  // MSG91's template editor forces NAMED variables (e.g. {{recipient_name}})
  // rather than positional {{1}}. Confirmed by capturing MSG91's own "Send
  // WhatsApp" dashboard page's actual network request: the component key is
  // "body_" + the variable's name (e.g. body_recipient_name) — same body_N
  // pattern as positional templates (body_1, body_2), just with the name
  // instead of an index. Neither "body_1" nor the bare variable name alone
  // work; both fail silently. `variables` keys here must exactly match the
  // approved template's variable names.
  const components = {};
  for (const [key, value] of Object.entries(variables || {})) {
    components[`body_${key}`] = { type: "text", value: value ?? "" };
  }

  const url = "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";
  const payload = {
    integrated_number: process.env.MSG91_WHATSAPP_NUMBER,
    content_type: "template",
    payload: {
      type: "template",
      template: {
        name: templateName,
        language: {
          code: process.env.MSG91_WHATSAPP_REMINDER_TEMPLATE_LANG || "en",
          policy: "deterministic",
        },
        to_and_components: [{ to: [cleanPhone], components }],
      },
    },
  };

  const response = await axios.post(url, payload, {
    headers: {
      authkey: process.env.MSG91_EMAIL_AUTHKEY,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
  return response.data;
}

// ─── Verify/reject WhatsApp notifications ──────────────────────────────────
// Shared with woglo-backend's vendor equivalent — same generic
// "your verification is complete/rejected" wording and the same pair of
// pre-approved templates (MSG91_WHATSAPP_VERIFIED_TEMPLATE_NAME /
// MSG91_WHATSAPP_REJECTED_TEMPLATE_NAME) work for both, so only one
// template pair needs creating in MSG91, not one per entity type. The
// rejected template carries the admin's manually-typed reason as a
// variable — same Marketing-reclassification risk flagged elsewhere in
// this file; this function no-ops safely (falls back to in-app-only) until
// a working template name is set.
async function sendVerificationStatusWhatsApp(phone, name, status, reason) {
  const templateName =
    status === "approved" || status === "verified"
      ? process.env.MSG91_WHATSAPP_VERIFIED_TEMPLATE_NAME
      : process.env.MSG91_WHATSAPP_REJECTED_TEMPLATE_NAME;
  if (!templateName) {
    console.warn(`No WhatsApp ${status} template configured — skipping (in-app notification still sent)`);
    return null;
  }
  const variables = { recipient_name: name || "there" };
  if (status === "rejected") variables.reason = reason || "Please contact support for details";
  return sendWhatsAppTemplate(phone, templateName, variables);
}

async function sendResetEmailViaMsg91(email, token) {
  const resetLink = `${process.env.FRONTEND_RESET_URL}?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

  const payload = {
    recipients: [
      {
        to: [{ email }],
        variables: {
          reset_link: resetLink,
          email,
        },
      },
    ],
    from: {
      email: process.env.MSG91_EMAIL_FROM,
      name: process.env.MSG91_EMAIL_FROM_NAME || "Woglo",
    },
    domain: process.env.MSG91_EMAIL_DOMAIN,
    template_id: process.env.MSG91_EMAIL_TEMPLATE_ID,
  };

  try {
    const response = await axios.post(
      "https://api.msg91.com/api/v5/email/send",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          authkey: process.env.MSG91_EMAIL_AUTHKEY,
        },
      }
    );
    console.log("MSG91 Reset Email Success:", response.data);
    return response.data;
  } catch (err) {
    console.error("MSG91 Reset Email Error:", err.response?.data || err.message);
    throw new Error("Failed to send reset email");
  }
}

async function sendForgotPasswordEmailViaMsg91(email, otp, appType) {
  // Default to the general template (Vendor App)
  let templateId = process.env.MSG91_EMAIL_TEMPLATE_ID;
  
  // Use the Driver-specific template if provided
  if (appType === 'driver' && process.env.MSG91_DRIVER_FORGOT_PASSWORD_TEMPLATE_ID) {
    templateId = process.env.MSG91_DRIVER_FORGOT_PASSWORD_TEMPLATE_ID;
  }

  // Construct the reset link (only for Vendor App)
  let variables = {
    otp: otp,
    email: email,
  };

  if (appType !== 'driver' && process.env.FRONTEND_RESET_URL) {
    variables.reset_link = `${process.env.FRONTEND_RESET_URL}?otp=${encodeURIComponent(otp)}&email=${encodeURIComponent(email)}`;
  }

  const payload = {
    recipients: [
      {
        to: [
          {
            email: email,
            name: email.split("@")[0], // Fallback name
          },
        ],
        variables: variables,
      },
    ],
    from: {
      email: process.env.MSG91_EMAIL_FROM,
      name: process.env.MSG91_EMAIL_FROM_NAME || "Woglo",
    },
    domain: process.env.MSG91_EMAIL_DOMAIN,
    template_id: templateId,
  };

  try {
    const response = await axios.post(
      "https://api.msg91.com/api/v5/email/send",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          authkey: process.env.MSG91_EMAIL_AUTHKEY,
        },
      }
    );
    console.log("MSG91 Forgot Password Email Success:", response.data);
    return response.data;
  } catch (err) {
    const msg91Error = err.response?.data || err.message;
    console.error("MSG91 Forgot Password Email Error:", msg91Error);
    throw new Error(`Failed to send forgot password email: ${JSON.stringify(msg91Error)}`);
  }
}

async function sendSignupEmailViaMsg91(email, otp) {
  const payload = {
    recipients: [
      {
        to: [
          {
            email: email,
            name: email.split("@")[0],
          },
        ],
        variables: {
          otp: otp,
          email: email,
        },
      },
    ],
    from: {
      email: process.env.MSG91_EMAIL_FROM,
      name: process.env.MSG91_EMAIL_FROM_NAME || "Woglo",
    },
    domain: process.env.MSG91_EMAIL_DOMAIN,
    template_id: process.env.MSG91_EMAIL_SIGNUP_TEMPLATE_ID || process.env.MSG91_EMAIL_TEMPLATE_ID,
  };

  try {
    const response = await axios.post(
      "https://api.msg91.com/api/v5/email/send",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          authkey: process.env.MSG91_EMAIL_AUTHKEY,
        },
      }
    );
    console.log("MSG91 Signup Email Success:", response.data);
    return response.data;
  } catch (err) {
    const msg91Error = err.response?.data || err.message;
    console.error("MSG91 Signup Email Error:", msg91Error);
    throw new Error(`Failed to send signup email: ${JSON.stringify(msg91Error)}`);
  }
}

module.exports = {
  sendResetEmailViaMsg91,
  sendSignupEmailViaMsg91,
  sendForgotPasswordEmailViaMsg91,
  sendOtpViaMsg91,
  sendWhatsAppTemplate,
  sendVerificationStatusWhatsApp,
};
