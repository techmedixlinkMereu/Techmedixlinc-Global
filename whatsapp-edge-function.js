// ─────────────────────────────────────────────────────────────────
// TechMedixLink · Supabase Edge Function
// File: supabase/functions/send-whatsapp/index.ts
//
// DEPLOY:
//   1. Install Supabase CLI: npm install -g supabase
//   2. supabase login
//   3. supabase functions deploy send-whatsapp --project-ref nvmwblzoyewgvawdmkyo
//   4. Set secret: supabase secrets set WHATSAPP_TOKEN=your_meta_token
//   5. Set secret: supabase secrets set WHATSAPP_PHONE_ID=your_phone_number_id
//
// TRIGGER: This function is called by a Postgres webhook on
//   INSERT into public.notifications WHERE channel = 'whatsapp'
//
// SETUP WEBHOOK in Supabase Dashboard:
//   Database → Webhooks → Create new webhook
//   Table: notifications
//   Events: INSERT
//   URL: https://nvmwblzoyewgvawdmkyo.supabase.co/functions/v1/send-whatsapp
//   HTTP Headers: Authorization: Bearer <your-service-role-key>
// ─────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WHATSAPP_TOKEN    = Deno.env.get("WHATSAPP_TOKEN")!;
const WHATSAPP_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID")!;
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  try {
    const body = await req.json();
    
    // Supabase webhook payload
    const record = body.record;
    if (!record || record.channel !== "whatsapp") {
      return new Response("Not a WhatsApp notification", { status: 200 });
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Get user phone number
    const { data: user } = await sb
      .from("users")
      .select("phone, full_name")
      .eq("id", record.user_id)
      .single();

    if (!user?.phone) {
      return new Response("No phone number for user", { status: 200 });
    }

    // Clean phone number to international format
    let phone = user.phone.replace(/[^0-9+]/g, "");
    if (phone.startsWith("0")) phone = "255" + phone.slice(1);
    if (phone.startsWith("+")) phone = phone.slice(1);

    // Send via WhatsApp Business API (Meta)
    const message = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: "order_update",   // Must be approved in Meta Business Manager
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: user.full_name || "Customer" },
              { type: "text", text: record.title || "Update" },
              { type: "text", text: record.message || "" },
            ],
          },
        ],
      },
    };

    // Fallback: send as free-form text if template not set up
    // (Only works within 24hr window of user messaging you first)
    const freeformMessage = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: {
        body: `*TechMedixLink*\n\n*${record.title}*\n\n${record.message}\n\n_Reply STOP to unsubscribe_`,
      },
    };

    const response = await fetch(
      `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(freeformMessage),
      }
    );

    const result = await response.json();

    // Mark notification as delivered in DB
    if (result.messages?.[0]?.id) {
      await sb
        .from("notifications")
        .update({ is_delivered: true, updated_at: new Date().toISOString() })
        .eq("id", record.id);
    }

    console.log("WhatsApp sent:", result);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
      status: response.status,
    });

  } catch (error) {
    console.error("WhatsApp Edge Function error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// ─────────────────────────────────────────────────────────────────
// WHATSAPP TEMPLATE SETUP (Meta Business Manager)
// ─────────────────────────────────────────────────────────────────
// Create a template named "order_update" with this body:
//
// Hello {{1}}, your TechMedixLink order update:
// *{{2}}*
// {{3}}
//
// Visit techmedixlinkmereu.github.io/techmedixlink-Global to view details.
//
// NOTE: Templates must be approved by Meta before use (~24-48 hours).
// For testing, use the freeformMessage instead (24hr window only).
// ─────────────────────────────────────────────────────────────────
