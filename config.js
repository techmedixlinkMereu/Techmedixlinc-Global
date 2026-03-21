// ─────────────────────────────────────────────────────────────────
// TechMedixLink · config.js
// ─────────────────────────────────────────────────────────────────
// IMPORTANT: Add this file to .gitignore before pushing to GitHub
//   echo "config.js" >> .gitignore
//
// For production, set these via environment variables or a
// deployment secrets manager (Netlify env vars, Vercel env vars).
// ─────────────────────────────────────────────────────────────────

const TECHMEDIX_CONFIG = {
  supabase: {
    url: 'https://nvmwblzoyewgvawdmkyo.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52bXdibHpveWV3Z3Zhd2Rta3lvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4ODQ2NzAsImV4cCI6MjA4NzQ2MDY3MH0.5AcVEcOYqy7784DRr_UGSKsVCpyh2Zvx7zjjLOLur_k',
  },
  app: {
    name: 'TechMedixLink',
    tagline: 'Medical Equipment Platform · Tanzania',
    version: '10.0.0',
    supportEmail: 'support@techmedixlink.co.tz',
    defaultCurrency: 'TZS',
    fallbackRate: 2500,         // USD→TZS fallback if live rate unavailable
    serviceFeePercent: 0.10,    // 10% platform service fee
    shippingPercent: 0.08,      // 8% estimated shipping
    maxUploadMB: 5,             // max image upload size
  }
};
