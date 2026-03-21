// ─────────────────────────────────────────────────────────────────
// TechMedixLink · app.js  (requires config.js loaded first)
// ─────────────────────────────────────────────────────────────────
// SECTIONS:
//   1.  Supabase client init
//   2.  State -- core, data, exchange rate, modals, auth, filters
//   3.  Computed -- roles, UI labels, request aggregates, filters
//   4.  Status config -- statusList, stepperStages, helpers
//   5.  Data loaders -- loadAll, loadProds, loadReqs, loadPayments…
//   6.  Analytics -- loadAnalytics, renderCharts
//   7.  Auth -- doLogin, doMagicLink, doPasswordReset, doSignup…
//   8.  Profile & addresses
//   9.  Products / listings -- saveListing, uploadImage, delete…
//  10.  Requests -- saveReq, updateStatus, cancel, track…
//  11.  Payments -- doPayment, validateMpesaRef
//  12.  Quotes -- sendQuote, acceptQuote, declineQuote
//  13.  Reviews -- saveReview, loadProductReviews
//  14.  Shoppers -- saveShopper, assignShopper
//  15.  Admin -- adminEditUser, toggleVerified, adminToggleUserRole
//  16.  Notifications -- createNotification, clickNotification
//  17.  Security -- sanitize, verifyAdminServer, checkAuthRateLimit
//  18.  Formatters -- fNum, tzs, fDate, fDateTime, fEvent…
//  19.  Keyboard, watchers, onMounted
//  20.  Return -- all exported refs/functions for Vue template
// ─────────────────────────────────────────────────────────────────

(function() {

// ── 1. SUPABASE CLIENT ──────────────────────────────────────────
  const sb = supabase.createClient(
    TECHMEDIX_CONFIG.supabase.url,
    TECHMEDIX_CONFIG.supabase.anonKey
  );

// ── 2. STATE ────────────────────────────────────────────────────
  const { createApp, ref, reactive, computed, onMounted, nextTick, watch } = Vue;

  const app = createApp({
    setup() {
      // ── Core state ──
      const loading        = ref(false);
      const authLanding    = ref(false);   // full-screen landing while exchanging token
      const authLandingMsg = ref('Signing you in securely…');
      const showPasswordUpdate = ref(false); // password update form after recovery
      const newPassword    = ref('');
      const newPasswordErr = ref('');
      const loadMsg    = ref('Loading…');
      const platform   = ref('techmedix');
      const tab        = ref('home');
      const sidebarOpen = ref(false);
      const globalSearch = ref('');

      // ── Data ──
      const products      = ref([]);
      const allRequests   = ref([]);
      const payments      = ref([]);
      const profile       = ref(null);
      const notifications = ref([]);
      const adminUsers    = ref([]);
      const shoppers      = ref([]);
      const addresses     = ref([]);
      const analyticsData = ref({});
      const sellerAnalytics = ref({});
      const sellerAnalyticsLoading = ref(false);


      // ── Procurement basket ──
      const basket     = ref([]);
      const showBasket = ref(false);

      function addToBasket(p, qty=1) {
        if (!profile.value) { showAuth.value=true; return; }
        const ex = basket.value.find(i=>i.product.id===p.id);
        if (ex) { ex.quantity+=qty; toast('ok','Updated',p.name+' qty updated'); }
        else { basket.value.push({product:p,quantity:qty,notes:''}); toast('ok','Added to basket',p.name); }
      }
      function removeFromBasket(pid) { basket.value=basket.value.filter(i=>i.product.id!==pid); }
      function clearBasket() { basket.value=[]; }
      const basketTotal = computed(()=>basket.value.reduce((s,i)=>s+(i.product.base_price_usd*i.quantity*(usdToTzs.value||2650)),0));
      const basketCount = computed(()=>basket.value.reduce((s,i)=>s+i.quantity,0));

      async function submitBasket() {
        if (!basket.value.length||!profile.value) return;
        loading.value=true; loadMsg.value='Submitting procurement request…';
        const numId=Math.random().toString(36).slice(2,8).toUpperCase();
        const prefix=platform.value==='techmedix'?'TML':'GDR';
        const request_number=`${prefix}-${new Date().getFullYear()}-${numId}`;
        const total=Math.round(basketTotal.value);
        const {data:reqData,error:reqErr}=await sb.from('requests').insert({
          user_id:profile.value.id,platform_type:platform.value,
          request_number,status:'pending',urgency:'normal',source_type:'catalog',
          total_cost:total,balance_due:total,deposit_paid:0,payment_status:'pending',currency:'TZS',
          source_notes:`PROCUREMENT BASKET: ${basket.value.length} items`,
          created_at:new Date().toISOString(),updated_at:new Date().toISOString()
        }).select().single();
        if (reqErr){loading.value=false;toast('err','Error',reqErr.message);return;}
        const items=basket.value.map(i=>({
          request_id:reqData.id,product_id:i.product.id,product_name:i.product.name,
          quantity:i.quantity,unit_price:Math.round(i.product.base_price_usd*(usdToTzs.value||2650)),
          total_price:Math.round(i.product.base_price_usd*i.quantity*(usdToTzs.value||2650)),
          notes:i.notes||null,created_at:new Date().toISOString()
        }));
        await sb.from('request_items').insert(items);
        await sb.from('tracking_events').insert({
          request_id:reqData.id,event_type:'order_placed',event_status:'completed',
          description:`Procurement basket -- ${basket.value.length} items submitted`,
          location:'TechMedixLink Platform',event_time:new Date().toISOString(),created_at:new Date().toISOString()
        });
        await createNotification(profile.value.id,'status_update','Basket Submitted',
          `Procurement request ${request_number} for ${basket.value.length} items submitted.`,reqData.id,'in_app');
        await loadReqs();await loadProds();
        loading.value=false;showBasket.value=false;clearBasket();
        toast('ok','Procurement request submitted!',request_number);
        tab.value='my-requests';
      }

      // ── Exchange rate ──
      const usdToTzs      = ref(TECHMEDIX_CONFIG.app.fallbackRate);
      const rateSource    = ref('fallback');
      const rateUpdatedAt = ref(null);
      const rateAge       = computed(() => {
        if (!rateUpdatedAt.value) return null;
        const h = Math.round((Date.now() - new Date(rateUpdatedAt.value)) / 3600000);
        return h < 1 ? 'Updated just now' : h < 24 ? `Updated ${h}h ago` : `Updated ${Math.round(h/24)}d ago`;
      });

      // ── Modal states ──
      const showAuth         = ref(false);
      const showProfileModal = ref(false);
      const showListingModal = ref(false);
      const showReqModal     = ref(false);
      const showNotifPanel   = ref(false);
      const showUserPanel    = ref(false);
      const showQuoteModal   = ref(false);
      const showReviewModal  = ref(false);
      const showShopperModal = ref(false);
      const showInquiryDetail = ref(false);
      const inquiryReq = ref(null);
      const showAdminUserModal = ref(false);
      const adminViewUser = ref(null);
      const adminEditingUser = ref(false);
      const adminUF = reactive({ full_name:'', phone:'', user_type:'individual', user_role:'buyer', company_name:'' });
      const showTcModal = ref(false);
      const showCancelModal = ref(false);
      const cancelReq = ref(null);
      const cancelReason = ref('');
      const showVerifyModal = ref(false);
      const verifyDocs = reactive({ business_reg:'', tax_cert:'', tmda_license:'', notes:'' });
      const editingProd      = ref(null);
      const editingShopper   = ref(null);
      const detailReq        = ref(null);
      const paymentReq       = ref(null);
      const quoteReq         = ref(null);
      const reviewReq        = ref(null);
      const viewedProduct    = ref(null);
      const showProductDetail = ref(false);
      const lpCarousel       = ref(0);   // landing page carousel index
      const pd3dMode = ref(false);   // toggle between photo and 3D view
      const pdReviews        = ref([]);
      const pdLoading        = ref(false);
      const productReviews   = ref([]);
      const trackId          = ref('');
      const trackedReq       = ref(null);
      const confirm          = ref(null);
      const openStatusMenu   = ref(null);
      const assignShopperId  = ref('');
      const addingAddress    = ref(false);

      // ── Onboarding state ──
      const onboardStep   = ref(0);   // 0=off 1=role 2=type 3=profile 4=role-detail
      const showOnboarding = ref(false);
      const obF = reactive({
        // step 3 -- core profile
        full_name:'', phone:'', avatar_file:null, avatar_preview:'', avatar_uploading:false,
        // step 4 buyer extras
        facility_type:'', bed_count:'', supply_region:'Dar es Salaam', equipment_categories:[],
        // step 4 seller extras
        business_reg:'', tmda_license:'', supply_countries:['Tanzania'], product_categories:[],
      });

      // ── Auth form ──
      const authTab      = ref('login');
      const onboardingDone = ref(false);
      const rateLimitUntil = ref(0);   // timestamp when rate limit expires
      const rateLimitSecs  = ref(0);   // reactive countdown seconds
      const tcAccepted = ref(false);
      const authErr   = ref('');
      const magicSent = ref(false);
      const aF = reactive({ email:'', password:'', full_name:'', phone:'', user_role:'buyer', user_type:'individual', company_name:'', loginId:'' });

      // ── Admin filters ──
      const adminSubTab      = ref('requests');
      const adminUserSearch  = ref('');
      const adminUserRoleFilter = ref('all');
      const appLogoUrl       = ref(TECHMEDIX_CONFIG.app?.logoUrl || null);
      const adminReqSearch = ref('');
      const adminReqFilter = ref('all');
      const adminPlatFilter = ref('all');

      // ── Pagination ──
      const prodPage    = ref(0);  const PROD_PER_PAGE = 20;
      const reqPage     = ref(0);  const REQ_PER_PAGE  = 25;
      const userPage    = ref(0);  const USER_PER_PAGE = 30;
      const prodTotal   = ref(0);
      const reqTotal    = ref(0);
      const userTotal   = ref(0);

      // ── Browse filters ──
      const prodSearch    = ref('');
      const prodFilter    = ref('all');
      const prodTypeFilter = ref('all');
      const sortProd      = ref('newest');
      const filterTmda    = ref(false);
      const filterInStock = ref(false);
      const reqSearch     = ref('');
      const reqFilter     = ref('all');
      const reqPlatFilter = ref('all');

      // ── Forms ──
      const pF = reactive({ name:'', manufacturer:'', model_url:'', platform_type:'techmedix', product_type:'medical_device', description:'', base_price_usd:0, stock_quantity:0, warranty_months:12, country:'Tanzania', import_duty_percent:0, estimated_weight_kg:0, seller_name:'', tmda_certified:false, requires_installation:false, requires_training:false, is_active:true, image_url:'', imagePreview:'', imageFile:null, uploading:false, imageSize:'' });
      const rF = reactive({ platform_type:'techmedix', product_id:'', quantity:1, urgency:'normal', notes:'', source_type:'catalog', address_id:'', custom_name:'', custom_desc:'', source_url:'' });
      const uF = reactive({ full_name:'', phone:'', user_type:'individual', user_role:'buyer', company_name:'' });
      const pmtF = reactive({ amount:0, method:'mpesa', type:'deposit', reference:'', notes:'', phone:'' });
      const qF  = reactive({ item_cost:0, shipping_cost:0, duty_cost:0, service_fee:0, delivery_date:'', notes:'' });
      const reviewF = reactive({ rating:0, title:'', body:'' });
      const shF = reactive({ full_name:'', phone:'', city:'', country:'Tanzania', specialization:'', is_active:true });
      const addrF = reactive({ address_type:'home', region:'', district:'', street:'', landmark:'', is_default:false });

      // ── Toasts ──
      const toasts = ref([]);
      function toast(type, title, msg='') {
        const id = Date.now() + Math.random();
        toasts.value.push({ id, type, title, msg });
        setTimeout(() => killToast(id), 4200);
      }
      function killToast(id) { toasts.value = toasts.value.filter(t => t.id !== id); }

      // ── 16. NOTIFICATIONS ──────────────────────────────────────
      // ── NOTIFICATION HELPER ──
      // Creates in-app + email notification records.
      // For actual email delivery, deploy a Supabase Edge Function triggered
      // by INSERT on the notifications table (using Resend or SendGrid).
      // Edge Function template: supabase/functions/send-notification/index.ts
      async function sendWhatsApp(phone, message) {
        if (!phone) return;
        try {
          await sb.functions.invoke('send-whatsapp', {
            body: { phone: phone.replace(/[^0-9+]/g,''), message }
          });
        } catch(e) { console.warn('WhatsApp fn:', e.message); }
      }

      async function createNotification(userId, type, title, message, requestId = null, channel = 'in_app') {
        try {
          await sb.from('notifications').insert({
            user_id: userId,
            request_id: requestId,
            notification_type: type,
            channel: channel,
            title: title,
            message: message,
            is_read: false,
            is_delivered: false,
            sent_at: new Date().toISOString()
          });
        } catch(e) { console.warn('Notification failed:', e); }
      }

      // ── 3. COMPUTED ──────────────────────────────────────────────
      // ── Profile completeness ──
      const adminTriage = computed(() => {
        const reqs = allRequests.value;
        return {
          pendingPayments:   reqs.filter(r => r.payment_status==='pending' && r.total_cost>0 && r.status!=='cancelled'),
          awaitingQuote:     reqs.filter(r => ['pending','submitted'].includes(r.status)),
          verifyRequests:    (adminUsers.value||[]).filter(u => u.company_name?.startsWith('[VERIFY_REQUESTED]')),
          stalled:           reqs.filter(r => {
            if (['completed','cancelled','delivered'].includes(r.status)) return false;
            const age = (Date.now()-new Date(r.updated_at||r.created_at))/86400000;
            return age > 3;
          }),
        };
      });

      const profileCompletion = computed(() => {
        if (!profile.value) return { pct:0, unlocks:[], next:null };
        const p = profile.value;
        const checks = [
          { key:'name',     done: !!p.full_name,                          pts:15, label:'Add your full name' },
          { key:'phone',    done: !!p.phone,                              pts:10, label:'Add phone number' },
          { key:'avatar',   done: !!p.avatar_url,                         pts:20, label:'Upload profile photo' },
          { key:'type',     done: !!p.user_type && p.user_type!=='individual' || p.user_type==='individual', pts:5, label:'Set account type' },
          { key:'address',  done: addresses.value.length > 0,             pts:15, label:'Add delivery address' },
          { key:'company',  done: !!p.company_name?.replace(/^\[.*?\]/,'').trim(), pts:5, label:'Add organisation name' },
          { key:'verified', done: p.company_name?.startsWith('[VERIFIED]'), pts:15, label:'Get seller verified' },
          { key:'request',  done: allRequests.value.filter(r=>r.user_id===p.id).length > 0, pts:10, label:'Submit your first request' },
          { key:'review',   done: false,                                   pts:5, label:'Receive your first review' },
        ];
        const total = checks.reduce((s,c) => s + c.pts, 0);
        const earned = checks.filter(c => c.done).reduce((s,c) => s + c.pts, 0);
        const pct = Math.round((earned / total) * 100);
        const unlocks = [
          { at:25, label:'Browse & request products',      icon:'fa-magnifying-glass', done: pct>=25 },
          { at:50, label:'Order tracking unlocked',        icon:'fa-location-dot',     done: pct>=50 },
          { at:75, label:'Priority support access',        icon:'fa-headset',          done: pct>=75 },
          { at:100,label:'Featured listing / buyer badge', icon:'fa-star',             done: pct>=100 },
        ];
        const next = checks.find(c => !c.done);
        return { pct, unlocks, next, checks };
      });

      // ── Computed roles ──
      const isAdmin = computed(() => profile.value?.user_role === 'admin');
      const canBuy  = computed(() => !profile.value || ['buyer','both'].includes(profile.value?.user_role));
      const canSell = computed(() => !!profile.value && ['seller','both'].includes(profile.value?.user_role));
      function roleLabel(r) { return { buyer:'Buyer', seller:'Seller', both:'Buyer & Seller', admin:'Admin' }[r] || r; }
      function roleIcon(r)  { return { buyer:'fa-cart-shopping', seller:'fa-store', both:'fa-arrows-left-right', admin:'fa-shield-halved' }[r] || 'fa-user'; }

      // ── Computed UI ──
      const pageTitle = computed(() => ({ home:'Dashboard', browse:'Browse Products', 'my-requests':'My Requests', 'my-listings':'My Listings', inquiries:'Inquiries', 'seller-analytics':'My Analytics', tracking:'Tracking', payments:'Payments', admin:'Admin Panel', 'admin-users':'All Users', 'admin-listings':'All Listings', analytics:'Analytics', shoppers:'Shoppers' })[tab.value] || 'TechMedixLink');
      const primaryLabel = computed(() => { if (!profile.value) return 'Sign In'; if (isAdmin.value) return 'Admin'; if (canBuy.value) return 'Request'; if (canSell.value) return 'List Product'; return 'Browse'; });
      const userInitial  = computed(() => profile.value?.full_name?.charAt(0)?.toUpperCase() || '?');
      const today        = computed(() => new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' }));
      const unreadCount  = computed(() => notifications.value.filter(n => !n.is_read).length);
      const uniqueCats   = computed(() => new Set(products.value.map(p => p.product_type).filter(Boolean)).size);

      // ── Request computed ──
      const myRequests   = computed(() => !profile.value ? [] : allRequests.value.filter(r => r.user_id === profile.value.id));
      const myListings   = computed(() => !profile.value ? [] : products.value.filter(p => p.user_id === profile.value.id));
      const incomingReqs = computed(() => {
        if (!profile.value || !canSell.value) return [];
        const myProdIds = myListings.value.map(p => p.id);
        return allRequests.value.filter(r => r.items?.some(it => myProdIds.includes(it.product_id)));
      });
      const myActiveReqs    = computed(() => myRequests.value.filter(r => !['delivered','completed','cancelled','installed'].includes(r.status)));
      const myDoneReqs      = computed(() => myRequests.value.filter(r => ['delivered','completed','installed'].includes(r.status)));
      const myTotalSpent    = computed(() => myRequests.value.reduce((s,r) => s + (r.deposit_paid||0), 0));
      const myBalanceDue    = computed(() => myRequests.value.reduce((s,r) => s + (r.balance_due||0), 0));
      const pendingPayCount = computed(() => myRequests.value.filter(r => (r.balance_due||0) > 0).length);
      const pendingAdminCount = computed(() => allRequests.value.filter(r => r.status === 'pending').length);
      const avgListingPrice = computed(() => !myListings.value.length ? 0 : myListings.value.reduce((s,p) => s+(p.base_price_usd||0),0) / myListings.value.length);

      // ── Selected product for request form ──
      const selectedProduct = computed(() => rF.product_id ? products.value.find(p => p.id === rF.product_id) : null);
      const reqCostEstimate = computed(() => {
        const p = selectedProduct.value;
        if (!p) return { items:0, shipping:0, duty:0, fee:0, total:0 };
        const items    = Math.round(p.base_price_usd * rF.quantity * usdToTzs.value);
        const shipping = Math.round(items * TECHMEDIX_CONFIG.app.shippingPercent);
        const duty     = rF.platform_type === 'globaldoor' ? Math.round(items * ((p.import_duty_percent||25)/100)) : 0;
        const fee      = Math.round((items + shipping + duty) * TECHMEDIX_CONFIG.app.serviceFeePercent);
        // ── 20. RETURN (Vue template exports) ───────────────────────
      return { items, shipping, duty, fee, total: items + shipping + duty + fee };
      });

      // ── Filtered products ──
      const filteredProds = computed(() => {
        let list = products.value.filter(p => p.is_active);
        if (prodSearch.value)     { const q = prodSearch.value.toLowerCase(); list = list.filter(p => p.name?.toLowerCase().includes(q) || p.manufacturer?.toLowerCase().includes(q) || p.country?.toLowerCase().includes(q)); }
        if (prodFilter.value !== 'all') {
          if (prodFilter.value === 'techmedix')     list = list.filter(p => p.platform_type === 'techmedix');
          else if (prodFilter.value === 'globaldoor')   list = list.filter(p => p.platform_type === 'globaldoor');
          else if (prodFilter.value === 'tmda')         list = list.filter(p => p.tmda_certified);
          else if (prodFilter.value === 'local')        list = list.filter(p => p.location_type === 'tanzania' || p.country?.toLowerCase().includes('tanzania'));
          else if (prodFilter.value === 'international') list = list.filter(p => p.location_type === 'international' || !p.country?.toLowerCase().includes('tanzania'));
        }
        if (prodTypeFilter.value !== 'all') list = list.filter(p => p.product_type === prodTypeFilter.value);
        if (filterTmda.value)    list = list.filter(p => p.tmda_certified);
        if (filterInStock.value) list = list.filter(p => (p.stock_quantity||0) > 0);
        if (sortProd.value === 'price_asc')  list = [...list].sort((a,b) => (a.base_price_usd||0) - (b.base_price_usd||0));
        else if (sortProd.value === 'price_desc') list = [...list].sort((a,b) => (b.base_price_usd||0) - (a.base_price_usd||0));
        else if (sortProd.value === 'name')  list = [...list].sort((a,b) => a.name?.localeCompare(b.name)||0);
        else list = [...list].sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
        return list;
      });

      const filteredMyReqs = computed(() => {
        let list = myRequests.value;
        if (reqSearch.value)       list = list.filter(r => r.request_number?.toLowerCase().includes(reqSearch.value.toLowerCase()));
        if (reqFilter.value !== 'all')    list = list.filter(r => r.status === reqFilter.value);
        if (reqPlatFilter.value !== 'all') list = list.filter(r => r.platform_type === reqPlatFilter.value);
        return list.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
      });

      const filteredAdminReqs = computed(() => {
        let list = allRequests.value;
        if (adminReqSearch.value)        list = list.filter(r => r.request_number?.toLowerCase().includes(adminReqSearch.value.toLowerCase()));
        if (adminReqFilter.value !== 'all')   list = list.filter(r => r.status === adminReqFilter.value);
        if (adminPlatFilter.value !== 'all')  list = list.filter(r => r.platform_type === adminPlatFilter.value);
        return list.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
      });

      const recentActivity = computed(() => {
        const reqs = myRequests.value.slice().sort((a,b) => new Date(b.updated_at||b.created_at) - new Date(a.updated_at||a.created_at)).slice(0,5);
        return reqs.map(r => ({ id:r.id, title:r.request_number, sub:fDate(r.created_at), status:r.status, ico:r.platform_type==='techmedix'?'tm':'gd', icon:r.platform_type==='techmedix'?'fas fa-heart-pulse':'fas fa-globe' }));
      });

      const filteredAdminUsers = computed(() => {
        let users = adminUsers.value;
        if (adminUserSearch.value) {
          const q = adminUserSearch.value.toLowerCase();
          users = users.filter(u =>
            u.full_name?.toLowerCase().includes(q) ||
            u.email?.toLowerCase().includes(q) ||
            u.phone?.includes(q)
          );
        }
        if (adminUserRoleFilter.value !== 'all') {
          users = users.filter(u => u.user_role === adminUserRoleFilter.value);
        }
        return users;
      });

      const browseSubtitle = computed(() => {
        const total = products.value.filter(p => p.is_active).length;
        const shown = filteredProds.value.length;
        const parts = [];
        if (prodFilter.value === 'techmedix')     parts.push('TechMedixLink');
        if (prodFilter.value === 'globaldoor')    parts.push('GlobalDoor');
        if (prodFilter.value === 'tmda')          parts.push('TMDA certified');
        if (prodFilter.value === 'local')         parts.push('Tanzania stock');
        if (prodFilter.value === 'international') parts.push('International');
        if (prodTypeFilter.value !== 'all')       parts.push(prodTypeFilter.value.replace(/_/g,' '));
        if (filterTmda.value)                     parts.push('TMDA only');
        if (filterInStock.value)                  parts.push('in stock');
        if (prodSearch.value)                     parts.push('"' + prodSearch.value + '"');
        const label = parts.length ? parts.join(' · ') : 'all platforms';
        return shown === total
          ? total + ' products · ' + label
          : shown + ' of ' + total + ' · ' + label;
      });

      const activeFilterCount = computed(() => {
        let n = 0;
        if (prodFilter.value !== 'all')     n++;
        if (prodTypeFilter.value !== 'all') n++;
        if (filterTmda.value)               n++;
        if (filterInStock.value)            n++;
        if (prodSearch.value)               n++;
        return n;
      });

      function clearAllFilters() {
        prodSearch.value = '';
        prodFilter.value = 'all';
        prodTypeFilter.value = 'all';
        sortProd.value = 'newest';
        filterTmda.value = false;
        filterInStock.value = false;
      }

      const pStats = computed(() => {
        const total = products.value.length || 1;
        const tm = products.value.filter(p => p.platform_type === 'techmedix').length;
        return { tm: Math.round((tm/total)*100), gd: Math.round(((total-tm)/total)*100) };
      });

      // ── 4. STATUS CONFIG ──────────────────────────────────────────
      // ── Status list ──
      const statusList = [
        { val:'pending',           label:'Pending',           color:'#b8904a', short:'Pending' },
        { val:'quoted',            label:'Quoted',            color:'#5a90c8', short:'Quoted' },
        { val:'deposit_paid',      label:'Deposit Paid',      color:'#5da87a', short:'Deposit' },
        { val:'sourcing',          label:'Sourcing',          color:'#5a90c8', short:'Sourcing' },
        { val:'shipped',           label:'Shipped',           color:'#7a6fc8', short:'Shipped' },
        { val:'in_transit',        label:'In Transit',        color:'#5a90c8', short:'Transit' },
        { val:'customs_clearance', label:'Customs',           color:'#b8904a', short:'Customs' },
        { val:'delivered',         label:'Delivered',         color:'#5da87a', short:'Delivered' },
        { val:'installed',         label:'Installed',         color:'#5da87a', short:'Installed' },
        { val:'completed',         label:'Completed',         color:'#5da87a', short:'Complete' },
        { val:'cancelled',         label:'Cancelled',         color:'#c05050', short:'Cancelled' },
      ];
      const stepperStages = [
        { val:'pending',      short:'Order' },
        { val:'quoted',       short:'Quote' },
        { val:'deposit_paid', short:'Deposit' },
        { val:'sourcing',     short:'Source' },
        { val:'shipped',      short:'Shipped' },
        { val:'in_transit',   short:'Transit' },
        { val:'customs_clearance', short:'Customs' },
        { val:'delivered',    short:'Delivered' },
      ];

      function stepCls(status, idx) {
        const order = stepperStages.map(s => s.val);
        const cur = order.indexOf(status);
        if (cur < 0) return idx === 0 ? 'cur' : '';
        if (idx < cur) return 'done';
        if (idx === cur) return 'cur';
        return '';
      }

      function fStatus(s) { return statusList.find(x => x.val===s)?.label || (s ? s.replace(/_/g,' ') : '--'); }

      function sBadge(s) {
        const map = { pending:'b-wn', quoted:'b-in', deposit_paid:'b-ok', sourcing:'b-in', shipped:'b-in', in_transit:'b-in', customs_clearance:'b-wn', delivered:'b-ok', installed:'b-ok', completed:'b-ok', cancelled:'b-er', draft:'b-mu' };
        return map[s] || 'b-mu';
      }

      // ── 5. DATA LOADERS ──────────────────────────────────────────
      // ── DATA LOADING ──
      async function loadAll() {
        await loadExchangeRate().catch(e => console.warn('loadExchangeRate:', e));
        await loadProds().catch(e => console.warn('loadProds:', e));
        await loadReqs().catch(e => console.warn('loadReqs:', e));
        await loadPayments().catch(e => console.warn('loadPayments:', e));
      }

      async function loadExchangeRate() {
        try {
          const { data } = await sb.from('exchange_rates')
            .select('*').eq('is_current', true)
            .order('created_at', { ascending: false }).limit(1).single();
          if (data?.rate) {
            usdToTzs.value = parseFloat(data.rate);
            rateSource.value = 'live';
            rateUpdatedAt.value = data.created_at || data.valid_from;
          } else {
            rateSource.value = 'fallback';
            rateUpdatedAt.value = null;
          }
        } catch {
          rateSource.value = 'fallback';
          rateUpdatedAt.value = null;
        }
      }

      async function loadProds(page = 0) {
        try {
          const from = page * PROD_PER_PAGE;
          const to   = from + PROD_PER_PAGE - 1;
          const { data, error, count } = await sb.from('products')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(from, to);
          if (error) throw error;
          products.value = data || [];
          prodTotal.value = count || 0;
          prodPage.value  = page;
        } catch (e) { console.error('loadProds:', e); }
      }

      async function loadReqs(page = 0) {
        try {
          const from = page * REQ_PER_PAGE;
          const to   = from + REQ_PER_PAGE - 1;
          let q = sb.from('requests')
            .select('*, items:request_items(*)', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(from, to);
          if (!isAdmin.value && profile.value) q = q.eq('user_id', profile.value.id);
          const { data, error, count } = await q;
          if (error) throw error;
          allRequests.value = data || [];
          reqTotal.value  = count || 0;
          reqPage.value   = page;
        } catch (e) { console.error('loadReqs:', e); }
      }

      async function loadPayments() {
        if (!profile.value) return;
        try {
          // Query by user_id directly -- avoids .in() with large array causing 400
          const query = isAdmin.value
            ? sb.from('payments').select('*').order('payment_date', { ascending: false }).limit(100)
            : sb.from('payments').select('*').eq('user_id', profile.value.id).order('payment_date', { ascending: false });
          const { data, error } = await query;
          if (error) throw error;
          payments.value = data || [];
        } catch (e) { console.error('loadPayments:', e); }
      }

      async function loadNotifications() {
        if (!profile.value) return;
        try {
          const { data } = await sb.from('notifications').select('*').eq('user_id', profile.value.id).order('sent_at', { ascending: false }).limit(30);
          notifications.value = data || [];
        } catch {}
      }

      async function loadAdminUsers(page = 0) {
        if (!isAdmin.value) return;
        try {
          const from = page * USER_PER_PAGE;
          const to   = from + USER_PER_PAGE - 1;
          const { data, count } = await sb.from('users')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(from, to);
          adminUsers.value = data || [];
          userTotal.value  = count || 0;
          userPage.value   = page;
        } catch {}
      }

      async function loadShoppers() {
        try {
          const { data } = await sb.from('shoppers').select('*').order('created_at', { ascending: false });
          shoppers.value = data || [];
        } catch {}
      }

      async function loadAddresses() {
        if (!profile.value) return;
        try {
          const { data } = await sb.from('addresses').select('*').eq('user_id', profile.value.id);
          addresses.value = data || [];
        } catch {}
      }

      async function loadAnalytics() {
        if (!isAdmin.value) return;
        try {
          // Query FULL database -- not the paginated allRequests slice
          const [
            { count: totalReqs },
            { data: statusData },
            { data: gmvData },
            { data: rvData },
            { data: deliveryData },
          ] = await Promise.all([
            sb.from('requests').select('*', { count:'exact', head:true }),
            sb.from('requests').select('status'),
            sb.from('requests').select('total_cost,deposit_paid'),
            sb.from('reviews').select('rating'),
            sb.from('requests').select('actual_delivery_date,created_at')
              .in('status',['delivered','completed'])
              .not('actual_delivery_date','is',null),
          ]);
          const total = totalReqs || 1;
          const done  = (statusData||[]).filter(r=>['delivered','completed','installed'].includes(r.status)).length;
          const gmv   = (gmvData||[]).reduce((s,r)=>s+(r.total_cost||0),0);
          const collected = (gmvData||[]).reduce((s,r)=>s+(r.deposit_paid||0),0);
          const avgDays = deliveryData?.length
            ? Math.round(deliveryData.reduce((s,r)=>s+(new Date(r.actual_delivery_date)-new Date(r.created_at))/86400000,0)/deliveryData.length)
            : null;
          const avgRating = rvData?.length
            ? (rvData.reduce((s,r)=>s+r.rating,0)/rvData.length).toFixed(1)
            : null;
          // Monthly GMV for trend chart -- last 6 months
          const { data: monthlyData } = await sb.from('requests')
            .select('total_cost,created_at')
            .gte('created_at', new Date(Date.now()-180*86400000).toISOString());
          analyticsData.value = {
            totalGmv: gmv,
            totalCollected: collected,
            completionRate: Math.round((done/total)*100),
            avgDays: avgDays !== null ? avgDays+'d' : '--',
            avgRating: avgRating || '--',
            totalReqs: total,
            doneCount: done,
            monthlyData: monthlyData || [],
            statusData: statusData || [],
          };
          nextTick(() => { renderCharts(); });
        } catch(e) { console.error('loadAnalytics:', e); }
      }

      async function loadSellerAnalytics() {
        if (!profile.value || !canSell.value) return;
        sellerAnalyticsLoading.value = true;
        try {
          const myProductIds = myListings.value.map(p=>p.id);
          if (!myProductIds.length) { sellerAnalytics.value = { noProducts: true }; sellerAnalyticsLoading.value = false; return; }
          const [
            { data: inquiries },
            { data: revenue },
            { data: reviews },
          ] = await Promise.all([
            sb.from('request_items').select('product_id,quantity,total_price,request:request_id(status,created_at)')
              .in('product_id', myProductIds),
            sb.from('request_items').select('product_id,total_price,request:request_id(status,deposit_paid)')
              .in('product_id', myProductIds),
            sb.from('reviews').select('rating,reviewed_entity_id')
              .in('reviewed_entity_id', myProductIds),
          ]);
          const totalInquiries = inquiries?.length || 0;
          const converted = (inquiries||[]).filter(i=>['deposit_paid','processing','sourcing','shipped','delivered','completed'].includes(i.request?.status)).length;
          const totalRevenue = (revenue||[]).reduce((s,i)=>s+(i.total_price||0),0);
          const avgRating = reviews?.length ? (reviews.reduce((s,r)=>s+r.rating,0)/reviews.length).toFixed(1) : null;
          // Per-product breakdown
          const byProduct = {};
          (inquiries||[]).forEach(i => {
            if (!byProduct[i.product_id]) byProduct[i.product_id] = { inquiries:0, converted:0, revenue:0 };
            byProduct[i.product_id].inquiries++;
            if (['deposit_paid','processing','sourcing','shipped','delivered','completed'].includes(i.request?.status)) byProduct[i.product_id].converted++;
          });
          (revenue||[]).forEach(i => { if (byProduct[i.product_id]) byProduct[i.product_id].revenue += (i.total_price||0); });
          sellerAnalytics.value = { totalInquiries, converted, conversionRate: totalInquiries ? Math.round(converted/totalInquiries*100) : 0, totalRevenue, avgRating, byProduct, totalReviews: reviews?.length||0 };
        } catch(e) { console.error('sellerAnalytics:', e); }
        sellerAnalyticsLoading.value = false;
      }

      // ── 6. ANALYTICS ──────────────────────────────────────────────
      function renderCharts() {
        const reqs = analyticsData.value.statusData || allRequests.value;
        const chartOpts = { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ labels:{ color:'#3a5070', font:{ size:11, family:'Nunito Sans' } } } } };

        // Status chart
        const statusCounts = {};
        statusList.forEach(s => { statusCounts[s.label] = reqs.filter(r=>r.status===s.val).length; });
        const filtered = Object.entries(statusCounts).filter(([,v]) => v > 0);
        const scEl = document.getElementById('statusChart');
        if (scEl) {
          if (scEl._chart) scEl._chart.destroy();
          scEl._chart = new Chart(scEl, { type:'bar', data:{ labels:filtered.map(([k])=>k), datasets:[{ data:filtered.map(([,v])=>v), backgroundColor:'rgba(0,102,161,0.65)', borderColor:'rgba(0,102,161,1)', borderWidth:1.5, borderRadius:4 }] }, options:{ ...chartOpts, scales:{ x:{ ticks:{ color:'#7a90aa', font:{size:10,family:'Nunito Sans'} }, grid:{ color:'rgba(0,30,80,0.06)' } }, y:{ ticks:{ color:'#7a90aa', font:{size:10,family:'Nunito Sans'} }, grid:{ color:'rgba(0,30,80,0.06)' } } }, plugins:{ legend:{ display:false } } } });
        }

        // Platform chart
        const tml = reqs.filter(r=>r.platform_type==='techmedix').length;
        const gd  = reqs.filter(r=>r.platform_type==='globaldoor').length;
        const pcEl = document.getElementById('platformChart');
        if (pcEl) {
          if (pcEl._chart) pcEl._chart.destroy();
          pcEl._chart = new Chart(pcEl, { type:'doughnut', data:{ labels:['TechMedixLink','GlobalDoor'], datasets:[{ data:[tml,gd], backgroundColor:['rgba(0,102,161,0.75)','rgba(0,168,176,0.75)'], borderColor:['#0066a1','#00a8b0'], borderWidth:2 }] }, options:{ ...chartOpts } });
        }

        // Products chart
        const prodCounts = {};
        reqs.forEach(r => r.items?.forEach(it => { prodCounts[it.product_name] = (prodCounts[it.product_name]||0) + 1; }));
        const top5 = Object.entries(prodCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
        const prEl = document.getElementById('productsChart');
        if (prEl) {
          if (prEl._chart) prEl._chart.destroy();
          prEl._chart = new Chart(prEl, { type:'bar', data:{ labels:top5.map(([k])=>k.length>22?k.slice(0,22)+'…':k), datasets:[{ data:top5.map(([,v])=>v), backgroundColor:'rgba(0,168,176,0.60)', borderColor:'rgba(0,168,176,1)', borderWidth:1.5, borderRadius:4 }] }, options:{ ...chartOpts, indexAxis:'y', scales:{ x:{ ticks:{ color:'#7a90aa', font:{size:10,family:'Nunito Sans'} }, grid:{ color:'rgba(0,30,80,0.06)' } }, y:{ ticks:{ color:'#7a90aa', font:{size:10,family:'Nunito Sans'} }, grid:{ display:false } } }, plugins:{ legend:{ display:false } } } });
        }
      }


      // ── 17. SECURITY ────────────────────────────────────────────
      // ── SECURITY HELPERS ──
      // NOTE FOR DEPLOYMENT: Enable RLS on ALL tables in Supabase dashboard.
      // Required policies (add via Supabase SQL editor):
      //   users:    SELECT own row, UPDATE own row only
      //   products: SELECT all active, INSERT/UPDATE/DELETE own (user_id = auth.uid())
      //   requests: SELECT own (user_id = auth.uid()) OR admin role
      //   payments: SELECT own request payments only
      //   reviews:  INSERT own, SELECT all
      //   notifications: SELECT/UPDATE own
      //   shopper_assignments, tracking_events: admin only for write

      // Client-side input sanitizer -- strip HTML tags, limit length
      function sanitize(str, maxLen = 500) {
        if (!str) return '';
        return String(str).replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
      }

      // Server-side admin re-verification before sensitive operations
      async function verifyAdminServer() {
        if (!profile.value || profile.value.user_role !== 'admin') return false;
        try {
          const { data } = await sb.from('users')
            .select('user_role')
            .eq('id', profile.value.id)
            .single();
          return data?.user_role === 'admin';
        } catch { return false; }
      }

      // Rate limit countdown timer
      let rateLimitTimer = null;
      function startRateLimitCountdown(seconds) {
        rateLimitUntil.value = Date.now() + seconds * 1000;
        rateLimitSecs.value  = seconds;
        if (rateLimitTimer) clearInterval(rateLimitTimer);
        rateLimitTimer = setInterval(() => {
          const remaining = Math.ceil((rateLimitUntil.value - Date.now()) / 1000);
          if (remaining <= 0) {
            rateLimitSecs.value = 0;
            rateLimitUntil.value = 0;
            clearInterval(rateLimitTimer);
          } else {
            rateLimitSecs.value = remaining;
          }
        }, 1000);
      }

      function fCountdown(secs) {
        if (secs <= 0) return '';
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        return m > 0 ? `${m}m ${s.toString().padStart(2,'0')}s` : `${s}s`;
      }

      // Auth rate limiter -- prevent brute force (client-side throttle)
      const authAttempts = { count: 0, resetAt: 0 };
      function checkAuthRateLimit() {
        const now = Date.now();
        if (now > authAttempts.resetAt) { authAttempts.count = 0; authAttempts.resetAt = now + 60000; }
        authAttempts.count++;
        if (authAttempts.count > 5) {
          authErr.value = 'Too many attempts. Please wait 60 seconds before trying again.';
          return false;
        }
        return true;
      }

      // ── 7. AUTH ──────────────────────────────────────────────────
      // ── AUTH ──
      async function doLogin() {
        if (!aF.loginId || !aF.password) return;
        if (!checkAuthRateLimit()) return;
        loading.value = true; loadMsg.value = 'Signing in…';
        let email = aF.loginId.trim();
        const isPhone = /^[+]?[0-9]{8,15}$/.test(email.replace(/[\s\-]/g,''));
        const isEmail = email.includes('@');
        if (!isEmail) {
          const q = isPhone
            ? sb.from('users').select('email').eq('phone', email.replace(/[^0-9+]/g,''))
            : sb.from('users').select('email').ilike('full_name', email);
          const { data: found } = await q.limit(1).single();
          if (found?.email) { email = found.email; }
          else { loading.value=false; authErr.value='No account found. Try your email address.'; return; }
        }
        const { error } = await sb.auth.signInWithPassword({ email, password: aF.password });
        loading.value = false;
        if (error) {
          const msg = error.message || '';
          if (msg.includes('Invalid login') || msg.includes('400')) {
            authErr.value = 'Incorrect email or password. If you signed up recently, check your email for a confirmation link first.';
          } else {
            authErr.value = msg;
          }
          return;
        }
        showAuth.value = false; aF.password = ''; aF.loginId = '';
      }

      async function updatePassword() {
        if (!newPassword.value || newPassword.value.length < 6) {
          newPasswordErr.value = 'Password must be at least 6 characters.';
          return;
        }
        loading.value = true; loadMsg.value = 'Updating password…';
        const { error } = await sb.auth.updateUser({ password: newPassword.value });
        loading.value = false;
        if (error) { newPasswordErr.value = error.message; return; }
        showPasswordUpdate.value = false;
        newPassword.value = '';
        newPasswordErr.value = '';
        toast('ok', 'Password updated', 'You are now signed in with your new password.');
      }

      async function doPasswordReset() {
        if (!aF.email) return;
        if (rateLimitSecs.value > 0) {
          authErr.value = `Please wait ${fCountdown(rateLimitSecs.value)} before requesting another email.`;
          return;
        }
        if (!checkAuthRateLimit()) return;
        loading.value = true; loadMsg.value = 'Sending reset link…';
        const { error } = await sb.auth.resetPasswordForEmail(aF.email, {
          redirectTo: window.location.origin + window.location.pathname
        });
        loading.value = false;
        if (error) {
          const msg = error.message || '';
          if (msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many') || msg.includes('429')) {
            startRateLimitCountdown(3600);
            authErr.value = '';
          } else {
            authErr.value = msg;
          }
          return;
        }
        magicSent.value = true;
      }

      async function doMagicLink() {
        if (!aF.email) return;
        if (rateLimitSecs.value > 0) {
          authErr.value = `Please wait ${fCountdown(rateLimitSecs.value)} before requesting another link.`;
          return;
        }
        if (!checkAuthRateLimit()) return;
        loading.value = true; loadMsg.value = 'Sending magic link…';
        const { error } = await sb.auth.signInWithOtp({
          email: aF.email,
          options: { emailRedirectTo: window.location.origin + window.location.pathname }
        });
        loading.value = false;
        if (error) {
          const msg = error.message || '';
          if (msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many') || msg.includes('429')) {
            startRateLimitCountdown(3600); // 1 hour Supabase limit
            authErr.value = '';  // clear -- we show the countdown UI instead
          } else {
            authErr.value = msg;
          }
          return;
        }
        magicSent.value = true;
      }

      async function doSignup() {
        if (!aF.email || !aF.password || !aF.full_name) return;
        if (!checkAuthRateLimit()) return;
        loading.value = true; loadMsg.value = 'Creating account…';
        const { data, error } = await sb.auth.signUp({ email: aF.email, password: aF.password });
        if (error) { loading.value = false; authErr.value = error.message; return; }
        if (data?.user) {
          await sb.from('users').insert({ id: data.user.id, email: aF.email, full_name: aF.full_name, phone: aF.phone||null, user_role: aF.user_role, user_type: aF.user_type, company_name: aF.company_name||null, created_at: new Date().toISOString() });
          await loadUserProfile(data.user.id);
          showAuth.value = false;
          await loadAll();
          await loadNotifications();
          if (isAdmin.value) { await loadAdminUsers(); await loadShoppers(); }
          // Start onboarding for new users
          startOnboarding();
        }
        loading.value = false;
      }

      async function doLogout() {
        await sb.auth.signOut();
        profile.value = null; notifications.value = []; allRequests.value = []; payments.value = []; addresses.value = [];
        showUserPanel.value = false; showProfileModal.value = false;
        tab.value = 'home';
        toast('info', 'Signed out');
      }

      async function loadUserProfile(userId) {
        try {
          const { data } = await sb.from('users').select('*').eq('id', userId).single();
          if (data) { profile.value = data; Object.assign(uF, { full_name: data.full_name||'', phone: data.phone||'', user_type: data.user_type||'individual', user_role: data.user_role||'buyer', company_name: data.company_name||'' }); }
        } catch {}
      }

      // ── 8. PROFILE & ADDRESSES ────────────────────────────────────
      // ── ONBOARDING ──

      function startOnboarding() {
        // Pre-fill what we know
        if (profile.value?.full_name) obF.full_name = profile.value.full_name;
        if (profile.value?.phone) obF.phone = profile.value.phone;
        onboardStep.value = 1;
        showOnboarding.value = true;
      }

      async function obSetRole(role) {
        await sb.from('users').update({ user_role: role, updated_at: new Date().toISOString() }).eq('id', profile.value.id);
        await loadUserProfile(profile.value.id);
        onboardStep.value = 2;
      }

      async function obSetType(type) {
        await sb.from('users').update({ user_type: type, updated_at: new Date().toISOString() }).eq('id', profile.value.id);
        await loadUserProfile(profile.value.id);
        onboardStep.value = 3;
      }

      function obHandleAvatar(e) {
        const file = e.target.files[0];
        if (!file) return;
        const allowed = ['image/jpeg','image/jpg','image/png','image/webp'];
        if (!allowed.includes(file.type)) { toast('err','Invalid type','Please upload a JPG or PNG'); return; }
        if (file.size > 3 * 1024 * 1024) { toast('err','Too large','Profile photo must be under 3MB'); return; }
        obF.avatar_file = file;
        const reader = new FileReader();
        reader.onload = ev => { obF.avatar_preview = ev.target.result; };
        reader.readAsDataURL(file);
      }

      async function obUploadAvatar() {
        if (!obF.avatar_file) return profile.value?.avatar_url || null;
        obF.avatar_uploading = true;
        try {
          const ext  = obF.avatar_file.name.split('.').pop();
          const path = `avatars/${profile.value.id}.${ext}`;
          await sb.storage.from('avatars').upload(path, obF.avatar_file, { upsert: true, cacheControl:'3600' });
          const { data } = sb.storage.from('avatars').getPublicUrl(path);
          obF.avatar_uploading = false;
          return data.publicUrl;
        } catch(e) { obF.avatar_uploading = false; console.error('Avatar upload:', e); return null; }
      }

      async function obSaveProfile() {
        if (!obF.full_name) return;
        const avatarUrl = await obUploadAvatar();
        const update = {
          full_name:  sanitize(obF.full_name, 100),
          phone:      obF.phone || null,
          updated_at: new Date().toISOString(),
        };
        if (avatarUrl) update.avatar_url = avatarUrl;
        await sb.from('users').update(update).eq('id', profile.value.id);
        await loadUserProfile(profile.value.id);
        onboardStep.value = 4;
      }

      async function obSaveRoleDetail() {
        const p = profile.value;
        const isSeller = ['seller','both'].includes(p?.user_role);
        const update = { updated_at: new Date().toISOString() };
        if (isSeller) {
          // Store seller details in company_name field (prefixed) + verification notes
          const existing = p.company_name?.replace(/^\[.*?\]/,'') || '';
          update.company_name = existing; // keep any existing verification prefix
        } else {
          // Buyer: store facility info in company_name
          if (obF.facility_type) update.company_name = obF.facility_type + (obF.bed_count ? ` (${obF.bed_count} beds)` : '');
        }
        await sb.from('users').update(update).eq('id', profile.value.id);
        await loadUserProfile(profile.value.id);
        showOnboarding.value = false;
        onboardStep.value = 0;
        onboardingDone.value = true;
        toast('ok', 'Profile complete!', 'Welcome to TechMedixLink');
        await loadAll();
        await loadNotifications();
        if (isAdmin.value) { await loadAdminUsers(); await loadShoppers(); }
        await loadAddresses();
      }

      function obSkip() {
        showOnboarding.value = false;
        onboardStep.value = 0;
      }

      // ── AVATAR upload for existing profile (not onboarding) ──
      async function handleAvatarChange(e) {
        const file = e.target.files[0];
        if (!file) return;
        const allowed = ['image/jpeg','image/jpg','image/png','image/webp'];
        if (!allowed.includes(file.type)) { toast('err','Invalid type','Please upload a JPG or PNG'); return; }
        if (file.size > 3 * 1024 * 1024) { toast('err','Too large','Profile photo must be under 3MB'); return; }
        loading.value = true; loadMsg.value = 'Uploading photo…';
        try {
          const ext  = file.name.split('.').pop();
          const path = `avatars/${profile.value.id}.${ext}`;
          await sb.storage.from('avatars').upload(path, file, { upsert:true, cacheControl:'3600' });
          const { data } = sb.storage.from('avatars').getPublicUrl(path);
          await sb.from('users').update({ avatar_url: data.publicUrl, updated_at: new Date().toISOString() }).eq('id', profile.value.id);
          await loadUserProfile(profile.value.id);
          toast('ok', 'Photo updated');
        } catch(e) { toast('err','Upload failed', e.message); }
        loading.value = false;
      }

      // ── PROFILE ──
      async function saveProfile() {
        if (!profile.value) return;
        const { error } = await sb.from('users').update({ full_name: uF.full_name, phone: uF.phone, user_type: uF.user_type, user_role: uF.user_role, company_name: uF.company_name, updated_at: new Date().toISOString() }).eq('id', profile.value.id);
        if (error) { toast('err','Error',error.message); return; }
        await loadUserProfile(profile.value.id);
        showProfileModal.value = false;
        toast('ok', 'Profile updated');
      }

      async function clickNotification(n) {
        // Mark this notification as read
        if (!n.is_read) {
          await sb.from('notifications').update({
            is_read: true,
            read_at: new Date().toISOString()
          }).eq('id', n.id);
          await loadNotifications();
        }
        showNotifPanel.value = false;
        // Navigate to related request if available
        if (n.request_id) {
          // Find the request and open detail modal
          const req = allRequests.value.find(r => r.id === n.request_id);
          if (req) {
            openDetailModal(req);
          } else {
            // Not loaded yet -- navigate to my-requests tab
            goTab('my-requests');
          }
        } else if (n.action_url) {
          window.location.href = n.action_url;
        }
      }

      async function markAllRead() {
        if (!profile.value) return;
        await sb.from('notifications').update({ is_read:true, read_at:new Date().toISOString() }).eq('user_id', profile.value.id).eq('is_read', false);
        await loadNotifications();
      }

      // ── ADDRESSES ──
      async function saveAddress() {
        if (!profile.value || !addrF.region) return;
        const { error } = await sb.from('addresses').insert({
          user_id:    profile.value.id,
          address_type: addrF.address_type || 'home',
          region:     sanitize(addrF.region, 100),
          district:   sanitize(addrF.district, 100) || null,
          street:     sanitize(addrF.street, 200) || null,
          landmark:   sanitize(addrF.landmark, 200) || null,
          is_default: addrF.is_default || false,
          created_at: new Date().toISOString()
        });
        if (error) { toast('err', 'Error', error.message); return; }
        await loadAddresses();
        Object.assign(addrF, { address_type:'home', region:'', district:'', street:'', landmark:'', is_default:false });
        addingAddress.value = false;
        toast('ok', 'Address saved');
      }

      async function deleteAddress(id) {
        await sb.from('addresses').delete().eq('id', id);
        await loadAddresses();
      }

      // ── PLATFORM ──
      function setPlatform(p) {
        platform.value = p;
        document.documentElement.setAttribute('data-platform', p);
        if (p === 'techmedix') prodFilter.value = 'techmedix';
        else prodFilter.value = 'globaldoor';
        tab.value = 'browse';
        sidebarOpen.value = false;
      }

      function goTab(t) { tab.value = t; sidebarOpen.value = false; closeAllMenus(); if (t==='analytics') nextTick(()=>loadAnalytics()); if (t==='seller-analytics') nextTick(()=>loadSellerAnalytics()); if (t==='shoppers') loadShoppers(); if (t==='admin-users'||t==='admin-listings') { loadAdminUsers(); loadProds(); } }

      function primaryAction() {
        if (!profile.value) { showAuth.value = true; return; }
        if (canBuy.value) { showReqModal.value = true; return; }
        if (canSell.value) { openListingModal(); return; }
        goTab('browse');
      }

      function performSearch() { if (globalSearch.value) { prodSearch.value = globalSearch.value; goTab('browse'); } }

      function closeAllMenus() { showNotifPanel.value = false; showUserPanel.value = false; openStatusMenu.value = null; }

      function togglePanel(which) {
        if (which === 'notif') { showNotifPanel.value = !showNotifPanel.value; showUserPanel.value = false; }
        else { showUserPanel.value = !showUserPanel.value; showNotifPanel.value = false; }
      }

      // ── 9. PRODUCTS / LISTINGS ──────────────────────────────────
      // ── LISTINGS ──
      function openListingModal(prod = null) {
        editingProd.value = prod;
        if (prod) { Object.assign(pF, { name:prod.name||'', manufacturer:prod.manufacturer||'', platform_type:prod.platform_type||'techmedix', product_type:prod.product_type||'medical_device', description:prod.description||'', base_price_usd:prod.base_price_usd||0, stock_quantity:prod.stock_quantity||0, warranty_months:prod.warranty_months||12, country:prod.country||'Tanzania', import_duty_percent:prod.import_duty_percent||0, estimated_weight_kg:prod.estimated_weight_kg||0, seller_name:prod.seller_name||'', tmda_certified:prod.tmda_certified||false, requires_installation:prod.requires_installation||false, requires_training:prod.requires_training||false, is_active:prod.is_active!==false, image_url:prod.image_url||'', imagePreview:prod.image_url||'', imageFile:null, uploading:false }); }
        else { resetPF(); }
        showListingModal.value = true;
      }

      function closeListing() { showListingModal.value = false; editingProd.value = null; resetPF(); }

      function resetPF() { Object.assign(pF, { name:'', manufacturer:'', platform_type:'techmedix', product_type:'medical_device', description:'', base_price_usd:0, stock_quantity:0, warranty_months:12, country:'Tanzania', import_duty_percent:0, estimated_weight_kg:0, seller_name:profile.value?.full_name||'', tmda_certified:false, requires_installation:false, requires_training:false, is_active:true, image_url:'', imagePreview:'', imageFile:null, uploading:false }); }

      function handleImageChange(e) {
        const file = e.target.files[0];
        if (!file) return;
        // Validate file type
        const allowedTypes = ['image/jpeg','image/jpg','image/png','image/webp','image/gif'];
        if (!allowedTypes.includes(file.type)) {
          toast('err','Invalid file type','Please upload a JPG, PNG, WebP, or GIF image.');
          e.target.value = '';
          return;
        }
        // Validate file size (max 5MB)
        const maxSize = 5 * 1024 * 1024; // 5MB in bytes
        if (file.size > maxSize) {
          toast('err','File too large',`Image must be under 5MB. Your file is ${(file.size/1024/1024).toFixed(1)}MB.`);
          e.target.value = '';
          return;
        }
        pF.imageFile = file;
        pF.imageSize = (file.size / 1024).toFixed(0) + 'KB';
        const reader = new FileReader();
        reader.onload = ev => { pF.imagePreview = ev.target.result; };
        reader.readAsDataURL(file);
      }

      async function uploadProductImage() {
        if (!pF.imageFile) return pF.image_url || '';
        pF.uploading = true;
        try {
          const ext  = pF.imageFile.name.split('.').pop();
          const path = `products/${Date.now()}.${ext}`;
          const { error: upErr } = await sb.storage.from('products').upload(path, pF.imageFile, { cacheControl:'3600', upsert:false });
          if (upErr) throw upErr;
          const { data } = sb.storage.from('products').getPublicUrl(path);
          pF.uploading = false;
          return data.publicUrl;
        } catch (e) { pF.uploading = false; console.error('Image upload failed:', e); return pF.image_url || ''; }
      }

      async function saveListing() {
        if (!pF.name || !pF.base_price_usd) return;
        loading.value = true; loadMsg.value = 'Saving listing…';
        const imageUrl = await uploadProductImage();
        const payload = { name:sanitize(pF.name,200), manufacturer:sanitize(pF.manufacturer,200), model_url:pF.model_url||null, platform_type:pF.platform_type, product_type:pF.product_type, description:sanitize(pF.description,2000), base_price_usd:pF.base_price_usd, stock_quantity:pF.stock_quantity, warranty_months:pF.warranty_months, country:pF.country, import_duty_percent:pF.import_duty_percent, estimated_weight_kg:pF.estimated_weight_kg, seller_name:pF.seller_name||profile.value?.full_name, tmda_certified:pF.tmda_certified, requires_installation:pF.requires_installation, requires_training:pF.requires_training, is_active:pF.is_active, image_url:imageUrl||null, updated_at:new Date().toISOString() };
        let error;
        if (editingProd.value) { ({ error } = await sb.from('products').update(payload).eq('id', editingProd.value.id)); }
        else { ({ error } = await sb.from('products').insert({ ...payload, user_id:profile.value.id, created_at:new Date().toISOString() })); }
        loading.value = false;
        if (error) { toast('err','Error',error.message); return; }
        await loadProds();
        closeListing();
        toast('ok', editingProd.value?'Product updated':'Product listed');
      }

      async function toggleListingStatus(p) {
        const { error } = await sb.from('products').update({ is_active: !p.is_active, updated_at: new Date().toISOString() }).eq('id', p.id);
        if (!error) { await loadProds(); toast('ok', p.is_active?'Product hidden':'Product activated'); }
      }

      function askDeleteProduct(p) {
        confirm.value = { title:'Delete Product', msg:`Permanently delete "${p.name}"? This cannot be undone.`, tone:'er', icon:'fas fa-trash', ok_lbl:'Delete', ok: () => deleteProduct(p.id) };
        if (showListingModal.value) closeListing();
      }

      async function deleteProduct(id) {
        // Allow: product owner OR admin
        const product = products.value.find(p => p.id === id);
        const isOwner = product?.user_id === profile.value?.id;
        if (!isOwner) {
          const ok = await verifyAdminServer();
          if (!ok) { toast('err', 'Unauthorised', 'You can only delete your own products.'); return; }
        }
        const { error } = await sb.from('products').delete().eq('id', id);
        if (error) { toast('err', 'Error', error.message); return; }
        await loadProds();
        toast('ok', 'Product deleted');
      }

      // ── 10. REQUESTS ─────────────────────────────────────────────
      // ── BASKET ──
      function addToBasket(p) {
        if (!profile.value) { showAuth.value = true; return; }
        const existing = basket.value.find(b => b.product.id === p.id);
        if (existing) { existing.quantity++; toast('ok', 'Quantity updated', p.name); }
        else { basket.value.push({ product:p, quantity:1, notes:'' }); toast('ok', 'Added to basket', p.name); }
        showBasket.value = true;
      }

      function removeFromBasket(idx) { basket.value.splice(idx,1); }


      async function submitBasket() {
        if (!basket.value.length || !profile.value) return;
        loading.value = true; loadMsg.value = 'Submitting basket…';
        const prefix = 'TML';
        const request_number = prefix+'-'+new Date().getFullYear()+'-'+Math.random().toString(36).slice(2,8).toUpperCase();
        const { data: reqData, error: reqErr } = await sb.from('requests').insert({
          user_id: profile.value.id, platform_type: 'techmedix',
          request_number, status: 'pending', urgency: 'normal',
          source_type: 'catalog',
          total_cost: basketTotal.value, deposit_paid: 0, balance_due: basketTotal.value,
          payment_status: 'pending', currency: 'TZS',
          source_notes: 'Procurement basket: '+basket.value.length+' items',
          created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        }).select().single();
        if (reqErr) { loading.value=false; toast('err','Error',reqErr.message); return; }
        // Insert all items
        for (const b of basket.value) {
          await sb.from('request_items').insert({
            request_id: reqData.id,
            product_id: b.product.id,
            product_name: b.product.name,
            quantity: b.quantity,
            unit_price: Math.round(b.product.base_price_usd * usdToTzs.value),
            total_price: Math.round(b.product.base_price_usd * b.quantity * usdToTzs.value),
            created_at: new Date().toISOString()
          });
        }
        await sb.from('tracking_events').insert({
          request_id: reqData.id, event_type:'order_placed', event_status:'completed',
          description: 'Procurement basket submitted: '+basket.value.length+' items',
          location:'TechMedixLink Platform', event_time:new Date().toISOString(), created_at:new Date().toISOString()
        });
        await createNotification(profile.value.id,'status_update','Basket Submitted','Your procurement request '+request_number+' has been submitted.',reqData.id,'in_app');
        basket.value = []; showBasket.value = false;
        loading.value = false;
        await loadReqs(); await loadProds();
        tab.value = 'my-requests';
        toast('ok','Basket submitted!', request_number);
      }

      // ── REQUESTS ──
      function quickRequest(p) {
        if (!profile.value) { showAuth.value = true; return; }
        rF.product_id = p.id;
        rF.platform_type = p.platform_type === 'both' ? 'techmedix' : (p.platform_type || 'techmedix');
        showReqModal.value = true;
      }

      async function saveReq() {
        const isCatalog = rF.source_type === 'catalog';
        const isCustom  = rF.source_type === 'manual';
        const isLink    = rF.source_type === 'link';
        if (isCatalog && !rF.product_id) return;
        if (isCustom && !rF.custom_name) return;
        if (isLink && !rF.source_url) return;
        if (!rF.quantity || !profile.value) return;
        loading.value = true; loadMsg.value = 'Submitting request…';
        const p = selectedProduct.value;
        const est = isCatalog ? reqCostEstimate.value : { items:0, shipping:0, duty:0, fee:0, total:0 };
        const numId = Math.random().toString(36).slice(2,8).toUpperCase();
        const prefix = rF.platform_type === 'techmedix' ? 'TML' : 'GDR';
        const request_number = `${prefix}-${new Date().getFullYear()}-${numId}`;
        const sourceNotes = [
          rF.notes,
          isCustom ? `ITEM: ${rF.custom_name}\nSPECS: ${rF.custom_desc}` : '',
          isLink   ? `PRODUCT LINK: ${rF.source_url}\nNOTES: ${rF.custom_desc}` : ''
        ].filter(Boolean).join('\n\n');
        const { data: reqData, error: reqErr } = await sb.from('requests').insert({
          user_id: profile.value.id, platform_type: rF.platform_type,
          request_number, status: isCatalog ? 'pending' : 'submitted',
          urgency: rF.urgency,
          source_type: rF.source_type,
          source_url: rF.source_url || null,
          source_notes: sourceNotes || null,
          item_cost: est.items, shipping_cost: est.shipping,
          duty_cost: est.duty, service_fee: est.fee,
          total_cost: est.total, deposit_paid: 0,
          balance_due: est.total,
          payment_status: 'pending', currency: 'TZS',
          created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        }).select().single();
        if (reqErr) { loading.value = false; toast('err','Error',reqErr.message); return; }
        // Insert item -- catalog uses product_id, custom/link uses product_name only
        await sb.from('request_items').insert({
          request_id: reqData.id,
          product_id: isCatalog ? p.id : null,
          product_name: isCatalog ? p.name : (rF.custom_name || rF.source_url?.slice(0,80) || 'Custom Item'),
          product_description: isCustom ? rF.custom_desc : (isLink ? rF.source_url : null),
          quantity: rF.quantity,
          unit_price: isCatalog ? Math.round(p.base_price_usd * usdToTzs.value) : 0,
          total_price: isCatalog ? Math.round(p.base_price_usd * rF.quantity * usdToTzs.value) : 0,
          created_at: new Date().toISOString()
        });
        await sb.from('tracking_events').insert({
          request_id: reqData.id, event_type:'order_placed', event_status:'completed',
          description: `Request ${request_number} submitted via ${rF.source_type === 'catalog' ? 'catalogue' : rF.source_type === 'link' ? 'product link' : 'custom request'}`,
          location:'TechMedixLink Platform', event_time: new Date().toISOString(), created_at: new Date().toISOString()
        });
        // Do NOT deduct inventory at submission -- deduct when deposit is paid
        // (prevents stock going negative if buyer submits then cancels)
        await loadReqs();
        await loadPayments();
        await loadProds();
        loading.value = false;
        showReqModal.value = false;
        Object.assign(rF, { platform_type:'techmedix', product_id:'', quantity:1, urgency:'normal', notes:'', source_type:'catalog', address_id:'', custom_name:'', custom_desc:'', source_url:'' });
        // Notify buyer confirmation + notify admins
        await createNotification(profile.value.id, 'status_update', 'Request Submitted', `Your request ${request_number} has been submitted and is under review.`, reqData.id, 'in_app');
        // Notify all admins (load admin users list for email)
        try {
          const { data: admins } = await sb.from('users').select('id').eq('user_role','admin');
          for (const admin of (admins||[])) {
            await createNotification(admin.id, 'status_update', 'New Request Received', `New request ${request_number} requires review.`, reqData.id, 'in_app');
          }
        } catch {}
        toast('ok','Request submitted', request_number);
        tab.value = 'my-requests';
      }

      function toggleStatusMenu(id) { openStatusMenu.value = openStatusMenu.value === id ? null : id; }

      async function updateStatus(r, newStatus) {
        openStatusMenu.value = null;
        if (isAdmin.value) {
          const ok = await verifyAdminServer();
          if (!ok) { toast('err','Unauthorised','Admin access required'); return; }
        }
        const { error } = await sb.from('requests').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', r.id);
        if (error) { toast('err','Error',error.message); return; }
        await sb.from('tracking_events').insert({ request_id: r.id, event_type:'status_update', event_status:'completed', description:`Status updated to: ${fStatus(newStatus)}`, event_time: new Date().toISOString(), created_at: new Date().toISOString() });
        // Notify the request owner about status change
        if (r.user_id) {
          await createNotification(r.user_id, 'status_update',
            `Order Update: ${fStatus(newStatus)}`,
            `Your request ${r.request_number} has been updated to: ${fStatus(newStatus)}.`,
            r.id, 'in_app');
        }
        await loadReqs();
        try {
          const { data: buyerD } = await sb.from('users').select('phone,full_name').eq('id', r.user_id).single();
          if (buyerD?.phone && ['shipped','delivered','customs_clearance'].includes(newStatus)) {
            const msg = newStatus==='shipped'?`Bidhaa yako imesafirishwa! Ref: ${r.request_number}`:
                        newStatus==='customs_clearance'?`Bidhaa ipo customs. Ref: ${r.request_number}`:
                        `Bidhaa imefika! Thibitisha kupokea. Ref: ${r.request_number}`;
            await sendWhatsApp(buyerD.phone, `TechMedixLink: ${msg}`);
          }
        } catch {}
        toast('ok', 'Status updated', fStatus(newStatus));
      }

      async function fetchTracking() {
        if (!trackId.value.trim()) return;
        loading.value = true; loadMsg.value = 'Searching…';
        const { data, error } = await sb.from('requests').select('*, tracking_events(*), items:request_items(*)').eq('request_number', trackId.value.trim().toUpperCase()).single();
        loading.value = false;
        if (error || !data) { trackedReq.value = null; toast('warn','Not found','Check request number and try again'); return; }
        if (data.tracking_events) data.tracking_events.sort((a,b) => new Date(a.event_time) - new Date(b.event_time));
        trackedReq.value = data;
      }

      function doTrack(num) { tab.value = 'tracking'; trackId.value = num; trackedReq.value = null; nextTick(fetchTracking); }

      async function openDetailModal(r) {
        let req = { ...r };
        if (!req.tracking_events) {
          const { data } = await sb.from('tracking_events').select('*').eq('request_id', r.id).order('event_time', { ascending: true });
          req.tracking_events = data || [];
        }
        if (!req.items) {
          const { data } = await sb.from('request_items').select('*').eq('request_id', r.id);
          req.items = data || [];
        }
        // Fetch shopper assignment from shopper_assignments table
        try {
          const { data: assignments } = await sb.from('shopper_assignments')
            .select('*, shopper:shopper_id(*)')
            .eq('request_id', r.id)
            .in('status', ['assigned','accepted','in_progress'])
            .order('assigned_at', { ascending: false })
            .limit(1);
          if (assignments?.length) {
            const asgn = assignments[0];
            req.shopper_name   = asgn.shopper?.full_name || '';
            req.shopper_avatar = asgn.shopper?.user_id ? (await sb.from('users').select('avatar_url').eq('id', asgn.shopper.user_id).single()).data?.avatar_url || null : null;
            req.shopper_phone  = asgn.shopper?.phone || '';
            req.shopper_city = asgn.shopper?.city || '';
            req.shopper_type = asgn.shopper?.shopper_type || '';
            req.shopper_rating = asgn.shopper?.rating || 0;
            req.assignment_type = asgn.assignment_type || '';
            req.assignment_status = asgn.status || '';
            req.shopper_assignment_id = asgn.id || null;
          }
        } catch(e) { console.error('shopper fetch:', e); }
        detailReq.value = req;
        assignShopperId.value = '';
        // Load reviews for items in this request
        if (req.items?.length && req.items[0]?.product_id) {
          loadProductReviews(req.items[0].product_id);
        } else {
          productReviews.value = [];
        }
      }

      // ── 11. PAYMENTS ─────────────────────────────────────────────
      // ── PAYMENT VALIDATION ──
      function validateMpesaRef(ref) {
        // M-Pesa Tanzania refs: alphanumeric, 8-12 chars (e.g. QJ12AB3456)
        if (!ref) return true; // optional
        return /^[A-Z0-9]{8,12}$/.test(ref.toUpperCase());
      }

      // ── CANCELLATION ──
      function askCancelRequest(r) {
        cancelReq.value = r;
        cancelReason.value = '';
        showCancelModal.value = true;
      }

      async function doCancel() {
        if (!cancelReq.value) return;
        loading.value = true; loadMsg.value = 'Cancelling request…';
        const reason = cancelReason.value || 'Cancelled by buyer';
        const { error } = await sb.from('requests').update({ 
          status: 'cancelled',
          source_notes: (cancelReq.value.source_notes ? cancelReq.value.source_notes + '\n\n' : '') + 'CANCELLATION REASON: ' + reason,
          updated_at: new Date().toISOString()
        }).eq('id', cancelReq.value.id);
        if (error) { loading.value = false; toast('err','Error',error.message); return; }
        await sb.from('tracking_events').insert({ 
          request_id: cancelReq.value.id, 
          event_type: 'order_placed',
          event_status: 'failed',
          description: 'Request cancelled by buyer. Reason: ' + reason,
          location: 'TechMedixLink Platform',
          event_time: new Date().toISOString(), 
          created_at: new Date().toISOString() 
        });
        await loadReqs();
        loading.value = false;
        showCancelModal.value = false;
        cancelReq.value = null;
        toast('warn', 'Request cancelled', reason);
      }

      // ── PAYMENTS ──
      function askPayment(r) {
        paymentReq.value = r;
        // Smart defaults: if partially paid → balance type, otherwise deposit
        const alreadyPaid = r.deposit_paid || 0;
        pmtF.type    = alreadyPaid > 0 ? 'balance' : 'deposit';
        pmtF.amount  = r.balance_due || 0;
        pmtF.method  = 'mpesa';
        pmtF.reference = '';
        pmtF.notes   = '';
        pmtF.phone   = profile.value?.phone || '';
      }

      async function doPayment(r) {
        if (!pmtF.amount || pmtF.amount <= 0) { toast('err','Invalid amount','Enter a valid payment amount'); return; }
        // Validate M-Pesa reference format if provided
        if (pmtF.method === 'mpesa' && pmtF.reference && !validateMpesaRef(pmtF.reference)) {
          toast('err','Invalid reference','M-Pesa reference should be 8-12 alphanumeric characters (e.g. QJ12AB3456)');
          return;
        }
        // Prevent overpayment
        if (pmtF.amount > (r.balance_due || 0) + 1) {
          toast('warn','Overpayment warning',`Amount exceeds balance due of ${tzs(r.balance_due)}`);
        }
        loading.value = true; loadMsg.value = 'Recording payment…';
        const newDeposit   = (r.deposit_paid||0) + pmtF.amount;
        const newBalance   = Math.max(0, (r.total_cost||0) - newDeposit);
        const newPayStatus = newBalance <= 0 ? 'paid' : 'partial';
        // Payment status: admin-recorded = completed; self-reported mpesa = pending verification
        const payStatus = isAdmin.value ? 'completed' : 'pending';
        const { data: payData, error: payErr } = await sb.from('payments').insert({
          request_id: r.id,
          user_id: r.user_id,
          amount: pmtF.amount,
          payment_method: pmtF.method,
          payment_type: pmtF.type,
          status: payStatus,
          currency: 'TZS',
          mpesa_reference: pmtF.reference ? pmtF.reference.toUpperCase() : null,
          mpesa_phone: pmtF.phone || null,
          notes: sanitize(pmtF.notes, 500) || null,
          payment_date: new Date().toISOString(),
          created_at: new Date().toISOString()
        }).select().single();
        if (payErr) { loading.value = false; toast('err','Error',payErr.message); return; }
        // Only update request financials if admin-confirmed
        if (isAdmin.value) {
          await sb.from('requests').update({
            deposit_paid: newDeposit,
            balance_due: newBalance,
            payment_status: newPayStatus,
            status: ['pending','processing','quoted'].includes(r.status) ? 'deposit_paid' : r.status,
            updated_at: new Date().toISOString()
          }).eq('id', r.id);
          // Deduct stock NOW -- only when payment is admin-confirmed
          const reqItems = (await sb.from('request_items').select('product_id,quantity').eq('request_id',r.id)).data || [];
          for (const item of reqItems) {
            if (!item.product_id) continue;
            const { data: prod } = await sb.from('products').select('stock_quantity').eq('id',item.product_id).single();
            if (prod) {
              await sb.from('products').update({
                stock_quantity: Math.max(0,(prod.stock_quantity||0)-item.quantity),
                updated_at: new Date().toISOString()
              }).eq('id',item.product_id);
            }
          }
        }
        await sb.from('tracking_events').insert({
          request_id: r.id,
          event_type: 'payment_received',
          event_status: isAdmin.value ? 'completed' : 'pending',
          description: `Payment of ${tzs(pmtF.amount)} ${isAdmin.value ? 'confirmed' : 'reported'} via ${pmtF.method?.replace(/_/g,' ')}${pmtF.reference ? ' · Ref: ' + pmtF.reference.toUpperCase() : ''}`,
          location: 'TechMedixLink Platform',
          event_time: new Date().toISOString(),
          created_at: new Date().toISOString()
        });
        await loadReqs();
        await loadPayments();
        loading.value = false;
        paymentReq.value = null;
        // Send notifications
        const payMsg = isAdmin.value
          ? `Payment of ${tzs(pmtF.amount)} confirmed for request ${r.request_number}.`
          : `Your payment of ${tzs(pmtF.amount)} for ${r.request_number} has been received and is pending verification.`;
        await createNotification(r.user_id, 'payment_received', isAdmin.value ? 'Payment Confirmed' : 'Payment Received', payMsg, r.id, 'in_app');
        if (isAdmin.value) {
          toast('ok', 'Payment confirmed', tzs(pmtF.amount));
        } else {
          toast('info', 'Payment submitted for verification', 'Admin will confirm within 24 hours. Reference: ' + (pmtF.reference || 'N/A'));
        }
      }

      // ── 12. QUOTES ──────────────────────────────────────────────
      // ── QUOTATION ──
      function openQuoteModal(r) {
        quoteReq.value = r;
        const est = { item_cost: r.item_cost||0, shipping_cost: r.shipping_cost||0, duty_cost: r.duty_cost||0, service_fee: r.service_fee||0 };
        Object.assign(qF, { item_cost:est.item_cost, shipping_cost:est.shipping_cost, duty_cost:est.duty_cost, service_fee:est.service_fee, delivery_date:'', notes:'' });
        showQuoteModal.value = true;
      }

      async function sendQuote() {
        if (!quoteReq.value || !qF.item_cost) return;
        loading.value = true; loadMsg.value = 'Sending quote…';
        const total = (qF.item_cost||0)+(qF.shipping_cost||0)+(qF.duty_cost||0)+(qF.service_fee||0);
        const { error } = await sb.from('requests').update({ status:'quoted', item_cost:qF.item_cost, shipping_cost:qF.shipping_cost, duty_cost:qF.duty_cost, service_fee:qF.service_fee, total_cost:total, balance_due:Math.max(0,total-(quoteReq.value.deposit_paid||0)), expected_delivery_date:qF.delivery_date||null, updated_at:new Date().toISOString() }).eq('id', quoteReq.value.id);
        if (error) { loading.value = false; toast('err','Error',error.message); return; }
        await sb.from('tracking_events').insert({ request_id:quoteReq.value.id, event_type:'quote_sent', event_status:'completed', description:`Quote of ${tzs(total)} sent to buyer. Notes: ${qF.notes||'None'}`, event_time:new Date().toISOString(), created_at:new Date().toISOString() });
        await loadReqs();
        loading.value = false;
        showQuoteModal.value = false;
        quoteReq.value = null;
        // Notify buyer that quote is ready
        if (quoteReq.value?.user_id) {
          await createNotification(quoteReq.value.user_id, 'payment_required', 'Quote Ready for Review', `Your quote for ${quoteReq.value.request_number} is ready. Total: ${tzs(total)}. Please review and accept or decline.`, quoteReq.value.id, 'in_app');
          // Also create email channel notification for Edge Function pickup
          await createNotification(quoteReq.value.user_id, 'payment_required', 'Your Quote is Ready -- TechMedixLink', `Dear customer, your quote for request ${quoteReq.value.request_number} has been prepared. Total amount: ${tzs(total)}. Log in to TechMedixLink to accept or decline.`, quoteReq.value.id, 'email');
        }
        try {
          const { data: buyerD } = await sb.from('users').select('phone,full_name').eq('id', quoteReq.value?.user_id).single();
          if (buyerD?.phone) await sendWhatsApp(buyerD.phone,
            `TechMedixLink: Habari ${buyerD.full_name||''}! Quotation yako iko tayari. Nambari: ${quoteReq.value?.request_number}`);
        } catch {}
        toast('ok','Quote sent to buyer');
      }

      async function acceptQuote(r) {
        // Status stays 'quoted' -- only moves to deposit_paid after admin confirms payment
        // Just open the payment modal so buyer can submit their M-Pesa reference
        askPayment(r);
        toast('ok', 'Quote accepted! Complete your deposit below to begin sourcing.');
      }

      async function confirmReceipt(r) {
        confirm.value = {
          title: 'Confirm Delivery',
          msg: 'Confirm that you have received your order in good condition? This will complete the request and prompt you to leave a review.',
          tone: 'ok', icon: 'fas fa-box-open', ok_lbl: 'Confirm Receipt',
          ok: async () => {
            await sb.from('requests').update({
              status: 'completed',
              actual_delivery_date: new Date().toISOString().split('T')[0],
              updated_at: new Date().toISOString()
            }).eq('id', r.id);
            await sb.from('tracking_events').insert({
              request_id: r.id, event_type: 'delivered', event_status: 'completed',
              description: 'Delivery confirmed by buyer.',
              location: 'Buyer confirmed', event_time: new Date().toISOString(), created_at: new Date().toISOString()
            });
            await loadReqs();
            // Open review modal
            const updated = allRequests.value.find(req => req.id === r.id);
            if (updated) openReviewModal(updated);
            toast('ok', 'Receipt confirmed!', 'Thank you -- please leave a review.');
          }
        };
      }

      async function declineQuote(r) {
        confirm.value = { title:'Decline Quote', msg:'Are you sure you want to decline this quote? The request will be cancelled.', tone:'er', icon:'fas fa-times', ok_lbl:'Decline Quote', ok: async () => { await updateStatus(r, 'cancelled'); toast('info','Quote declined'); } };
      }

      // ── 13. REVIEWS ─────────────────────────────────────────────
      // ── REVIEWS ──
      function openReviewModal(r) { reviewReq.value = r; reviewF.rating = 0; reviewF.title = ''; reviewF.body = ''; showReviewModal.value = true; }

      async function openProductDetail(p) {
        viewedProduct.value = p;
        showProductDetail.value = true;
        pd3dMode.value = false;   // always start in photo mode
        pdReviews.value = [];
        pdLoading.value = true;
        try {
          const { data: rvData } = await sb.from('reviews')
            .select('*')
            .eq('reviewed_entity_type', 'product')
            .eq('reviewed_entity_id', p.id)
            .order('created_at', { ascending: false })
            .limit(10);
          if (rvData?.length) {
            const userIds = [...new Set(rvData.map(r => r.user_id).filter(Boolean))];
            const { data: usersData } = await sb.from('users')
              .select('id, full_name, avatar_url')
              .in('id', userIds);
            const userMap = Object.fromEntries((usersData||[]).map(u => [u.id, u]));
            pdReviews.value = rvData.map(r => ({ ...r, user: userMap[r.user_id] || null }));
          } else {
            pdReviews.value = [];
          }
        } catch(e) { console.error('pdReviews:', e); }
        pdLoading.value = false;
      }

      async function loadProductReviews(productId) {
        try {
          const { data: rvData } = await sb.from('reviews')
            .select('*')
            .eq('reviewed_entity_type', 'product')
            .eq('reviewed_entity_id', productId)
            .order('created_at', { ascending: false });
          if (rvData?.length) {
            const userIds = [...new Set(rvData.map(r => r.user_id).filter(Boolean))];
            const { data: usersData } = await sb.from('users')
              .select('id, full_name, avatar_url')
              .in('id', userIds);
            const userMap = Object.fromEntries((usersData||[]).map(u => [u.id, u]));
            productReviews.value = rvData.map(r => ({ ...r, user: userMap[r.user_id] || null }));
          } else {
            productReviews.value = [];
          }
        } catch(e) { console.error('loadProductReviews:', e); }
      }

      async function saveReview() {
        if (!reviewReq.value || !reviewF.rating || !profile.value) return;
        const items     = reviewReq.value.items || [];
        const productId = items[0]?.product_id || null;
        // Combine title + body into review_text (schema has single text field)
        const reviewText = [reviewF.title, reviewF.body].filter(Boolean).join('\n\n') || null;
        const { error } = await sb.from('reviews').insert({
          user_id:              profile.value.id,
          request_id:           reviewReq.value.id,
          rating:               reviewF.rating,
          review_text:          reviewText,
          reviewed_entity_type: 'product',
          reviewed_entity_id:   productId,
          is_verified_purchase: true,
          created_at:           new Date().toISOString(),
          updated_at:           new Date().toISOString()
        });
        if (error) { toast('err', 'Error', error.message); return; }
        showReviewModal.value = false;
        reviewF.rating = 0; reviewF.title = ''; reviewF.body = '';
        toast('ok', 'Review submitted', 'Thank you for your feedback!');
      }

      // ── 14. SHOPPERS ────────────────────────────────────────────
      // ── SHOPPERS ──
      function openShopperModal(sh = null) { editingShopper.value = sh; if (sh) Object.assign(shF, { full_name:sh.full_name||'', phone:sh.phone||'', city:sh.city||'', country:sh.country||'Tanzania', specialization:sh.specialization||'', is_active:sh.is_active!==false }); else Object.assign(shF, { full_name:'', phone:'', city:'', country:'Tanzania', specialization:'', is_active:true }); showShopperModal.value = true; }

      async function saveShopper() {
        if (!shF.full_name) return;
        const payload = { full_name:shF.full_name, phone:shF.phone||null, city:shF.city, country:shF.country, specialization:shF.specialization||null, is_active:shF.is_active };
        let error;
        if (editingShopper.value) { ({ error } = await sb.from('shoppers').update({ ...payload, updated_at:new Date().toISOString() }).eq('id', editingShopper.value.id)); }
        else { ({ error } = await sb.from('shoppers').insert({ ...payload, created_at:new Date().toISOString() })); }
        if (error) { toast('err','Error',error.message); return; }
        await loadShoppers();
        showShopperModal.value = false;
        toast('ok', editingShopper.value?'Shopper updated':'Shopper added');
      }

      async function updateShopperStatus(r, newStatus) {
        if (!r.shopper_assignment_id) return;
        const { error } = await sb.from('shopper_assignments').update({
          status: newStatus,
          ...(newStatus==='accepted' ? {accepted_at: new Date().toISOString()} : {}),
          ...(newStatus==='completed' ? {completed_at: new Date().toISOString()} : {}),
        }).eq('id', r.shopper_assignment_id);
        if (!error) {
          await loadReqs();
          toast('ok','Shopper status updated', newStatus);
        }
      }

      async function assignShopper(r) {
        if (!assignShopperId.value) return;
        const sh = shoppers.value.find(s => s.id === assignShopperId.value);
        const { error } = await sb.from('requests').update({ shopper_id:assignShopperId.value, updated_at:new Date().toISOString() }).eq('id', r.id);
        if (error) { toast('err','Error',error.message); return; }
        if (detailReq.value?.id === r.id) { detailReq.value = { ...detailReq.value, shopper_name:sh?.full_name, shopper_phone:sh?.phone, shopper_id:assignShopperId.value }; }
        await loadReqs();
        toast('ok','Shopper assigned', sh?.full_name||'');
        assignShopperId.value = '';
      }

      // ── SELLER INQUIRY ACTIONS ──
      async function openInquiryDetail(r) {
        let req = { ...r };
        if (!req.items) {
          const { data } = await sb.from('request_items').select('*').eq('request_id', r.id);
          req.items = data || [];
        }
        inquiryReq.value = req;
        showInquiryDetail.value = true;
      }

      async function acceptInquiry(r) {
        const { error } = await sb.from('requests').update({
          status: 'submitted',   // submitted = seller acknowledged
          updated_at: new Date().toISOString()
        }).eq('id', r.id);
        if (error) { toast('err','Error',error.message); return; }
        await sb.from('tracking_events').insert({
          request_id: r.id, event_type: 'processing', event_status: 'completed',
          description: 'Inquiry accepted by seller. Quote will be provided shortly.',
          event_time: new Date().toISOString(), created_at: new Date().toISOString()
        });
        // Notify buyer
        if (r.user_id) await createNotification(r.user_id,'status_update',
          'Inquiry Accepted',
          'Your inquiry '+r.request_number+' has been accepted. A quote is being prepared.',
          r.id, 'in_app');
        await loadReqs();
        toast('ok','Inquiry accepted', 'Buyer notified. Please send a quote.');
      }

      async function acknowledgeInquiry(r) {
        // Seller acknowledges -- moves to quoted state, opens quote modal
        showInquiryDetail.value = false;
        inquiryReq.value = null;
        openQuoteModal(r);
      }

      async function declineInquiry(r) {
        confirm.value = {
          title: 'Decline Inquiry',
          msg: `Decline the inquiry ${r.request_number}? The buyer will be notified that this item is unavailable.`,
          tone: 'er', icon: 'fas fa-times-circle', ok_lbl: 'Decline',
          ok: async () => {
            const { error } = await sb.from('requests').update({
              status: 'cancelled',
              source_notes: (r.source_notes ? r.source_notes + '\n\n' : '') + 'DECLINED BY SELLER: Item unavailable or seller unable to fulfil.',
              updated_at: new Date().toISOString()
            }).eq('id', r.id);
            if (!error) {
              await sb.from('tracking_events').insert({
                request_id: r.id, event_type: 'order_placed', event_status: 'failed',
                description: 'Inquiry declined by seller -- item unavailable.',
                location: 'TechMedixLink Platform',
                event_time: new Date().toISOString(), created_at: new Date().toISOString()
              });
              await loadReqs();
              showInquiryDetail.value = false;
              toast('info', 'Inquiry declined');
            }
          }
        };
      }

      // ── 15. ADMIN ───────────────────────────────────────────────
      // ── ADMIN USER ACTIONS ──
      function adminEditUser(u) {
        adminViewUser.value = u;
        adminEditingUser.value = false;
        Object.assign(adminUF, { full_name:u.full_name||'', phone:u.phone||'', user_type:u.user_type||'individual', user_role:u.user_role||'buyer', company_name:u.company_name||'' });
        showAdminUserModal.value = true;
      }

      async function adminSaveUser() {
        if (!adminViewUser.value) return;
        const ok = await verifyAdminServer();
        if (!ok) { toast('err','Unauthorised'); return; }
        const { error } = await sb.from('users').update({
          full_name: sanitize(adminUF.full_name,100),
          phone: adminUF.phone || null,
          user_type: adminUF.user_type,
          user_role: adminUF.user_role,
          company_name: adminUF.company_name || null,
          updated_at: new Date().toISOString()
        }).eq('id', adminViewUser.value.id);
        if (error) { toast('err','Error',error.message); return; }
        await loadAdminUsers();
        adminEditingUser.value = false;
        adminViewUser.value = { ...adminViewUser.value, ...adminUF };
        toast('ok','User updated');
      }

      async function adminToggleUserRole(u) {
        const ok = await verifyAdminServer();
        if (!ok) { toast('err','Unauthorised','Admin access required'); return; }
        const roles = ['buyer','seller','both','admin'];
        const next = roles[(roles.indexOf(u.user_role)+1) % roles.length];
        const { error } = await sb.from('users').update({ user_role:next, updated_at:new Date().toISOString() }).eq('id', u.id);
        if (!error) { await loadAdminUsers(); toast('ok','Role updated', `${u.full_name} → ${roleLabel(next)}`); }
      }

      async function requestVerification() {
        if (!profile.value) return;
        // Store verification request in source_notes pattern via company_name tag
        const note = '[VERIFY_REQUESTED]' + (profile.value.company_name||'');
        const { error } = await sb.from('users').update({ 
          company_name: note,
          updated_at: new Date().toISOString() 
        }).eq('id', profile.value.id);
        if (!error) {
          await loadUserProfile(profile.value.id);
          showVerifyModal.value = false;
          toast('ok', 'Verification requested', 'Admin will review your documents within 2 business days');
        }
      }

      async function toggleVerified(u) {
        // Schema has no is_verified on users -- we use company_name prefix convention:
        // [VERIFY_REQUESTED]... = pending review
        // [VERIFIED]...         = approved
        // No prefix             = not requested
        const raw = u.company_name || '';
        const isVerified  = raw.startsWith('[VERIFIED]');
        const isPending   = raw.startsWith('[VERIFY_REQUESTED]');
        const actualName  = raw.replace(/^\[(VERIFIED|VERIFY_REQUESTED)\]/, '').trim();
        let newName;
        if (isVerified) {
          // Revoke -- strip [VERIFIED] prefix
          newName = actualName || null;
        } else if (isPending) {
          // Approve -- replace [VERIFY_REQUESTED] with [VERIFIED]
          newName = '[VERIFIED]' + actualName;
        } else {
          // Mark verified directly (admin override)
          newName = '[VERIFIED]' + actualName;
        }
        const { error } = await sb.from('users').update({
          company_name: newName,
          updated_at: new Date().toISOString()
        }).eq('id', u.id);
        if (!error) {
          await loadAdminUsers();
          toast('ok', isVerified ? 'Verification revoked' : 'User verified');
        }
      }

      // Helper to read verification state from company_name prefix
      function userVerifyStatus(u) {
        const cn = u?.company_name || '';
        if (cn.startsWith('[VERIFIED]'))          return 'verified';
        if (cn.startsWith('[VERIFY_REQUESTED]'))   return 'pending';
        return 'none';
      }

      function printPPRA(r) {
        // Generate PPRA-compliant procurement document
        const items = r.items || [];
        const rows = items.map((it,i) =>
          `<tr><td>${i+1}</td><td>${it.product_name}</td><td>${it.quantity}</td><td>${tzs(it.unit_price)}</td><td>${tzs(it.total_price)}</td></tr>`
        ).join('');
        const w = window.open('','_blank');
        w.document.write(`<!DOCTYPE html><html><head><title>PPRA Procurement Document</title>
        <link rel="stylesheet" href="app.css"></head><body>
        <div class="hd">
          <div><h1>TECHMEDIXLINK LTD</h1><h2>PPRA Procurement Document</h2>
          <div style="font-size:10px;color:#666;margin-top:4px">Medical Equipment Platform · Tanzania<br>PPRA Registration: TML-PROC-2024</div></div>
          <div class="ref">
            <div><strong>Ref:</strong> ${r.request_number}</div>
            <div><strong>Date:</strong> ${new Date().toLocaleDateString('en-TZ')}</div>
            <div><strong>Status:</strong> ${r.status?.toUpperCase()}</div>
          </div>
        </div>
        <table>
          <thead><tr><th>#</th><th>Item Description</th><th>Qty</th><th>Unit Price (TZS)</th><th>Total (TZS)</th></tr></thead>
          <tbody>${rows}<tr class="total-row"><td colspan="4" style="text-align:right">TOTAL</td><td>${tzs(r.total_cost)}</td></tr></tbody>
        </table>
        <div class="sig">
          <div class="sig-box">Procurement Officer<br>Name: ___________________<br>Signature: _______________<br>Date: ___________________</div>
          <div class="sig-box">Authorised Signatory<br>Name: ___________________<br>Signature: _______________<br>Date: ___________________</div>
          <div class="sig-box">Supplier Confirmation<br>Name: ___________________<br>Signature: _______________<br>Date: ___________________</div>
        </div>
        <div class="footer">This document is generated by TechMedixLink and is compliant with PPRA Act Cap 410 of Tanzania. 
        Retain this document for audit purposes.</div>
        </body></html>`);
        w.document.close(); w.print();
      }

      function printQuote(r) { window.print(); }

      // ── 18. FORMATTERS ──────────────────────────────────────────
      // ── FORMATTERS ──
      function fNum(n)     { if (n==null) return '0'; return Math.round(n).toLocaleString('en-US'); }
      function tzs(n)      { return 'TZS ' + fNum(n); }
      function fDate(d)    { if (!d) return '--'; const dt=new Date(d); return isNaN(dt)?'--':dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); }
      function fDateTime(d){ if (!d) return '--'; const dt=new Date(d); return isNaN(dt)?'--':dt.toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); }
      function fEvent(t)   { if (!t) return '--'; return t.split('_').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' '); }
      function stockLabel(n) { if (!n||n<=0) return 'Out of stock'; if (n<=2) return `Low stock (${n})`; return `${n} in stock`; }
      function stockClass(n) { if (!n||n<=0) return 'out-stock'; if (n<=2) return 'low-stock'; return 'in-stock'; }

      // ── 19. KEYBOARD, WATCHERS, MOUNT ───────────────────────────
      // ── KEYBOARD ──
      function handleKey(e) {
        if (e.key==='Escape') { if (detailReq.value) { detailReq.value=null; return; } if (showListingModal.value) { closeListing(); return; } if (showReqModal.value) { showReqModal.value=false; return; } if (showAuth.value) { showAuth.value=false; return; } if (showQuoteModal.value) { showQuoteModal.value=false; return; } if (showReviewModal.value) { showReviewModal.value=false; return; } closeAllMenus(); }
        if (e.key==='/' && !['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) { e.preventDefault(); document.querySelector('.srch-w input')?.focus(); }
      }

      // ── WATCHERS ──
      watch(authTab, () => { authErr.value = ''; magicSent.value = false; aF.password = ''; });

      // ── MOUNT ──
      onMounted(() => {
        document.addEventListener('keydown', handleKey);

        // Handle URL tokens (magic link / password reset callbacks)
        const params = new URLSearchParams(
          window.location.hash.startsWith('#')
            ? window.location.hash.slice(1)
            : window.location.search.slice(1)
        );
        const urlError = params.get('error_description');
        const urlType  = params.get('type');
        const urlToken = params.get('access_token');

        if (urlError) {
          showAuth.value = true;
          authErr.value = decodeURIComponent(urlError).replace(/\+/g,' ');
          history.replaceState(null,'',window.location.pathname);
        } else if (urlToken || urlType === 'recovery' || urlType === 'magiclink' || urlType === 'signup') {
          authLanding.value = true;
          authLandingMsg.value = urlType === 'recovery' ? 'Verifying your reset link…' : 'Signing you in securely…';
          history.replaceState(null,'',window.location.pathname);
        }

        // Single auth listener -- drives ALL data loading
        // Fires immediately with current session state on page load
        loading.value = true;
        loadMsg.value = 'Loading…';

        sb.auth.onAuthStateChange(async (event, session) => {
          try {
            if (event === 'PASSWORD_RECOVERY') {
              authLanding.value = false;
              showPasswordUpdate.value = true;
              await loadAll();

            } else if (event === 'SIGNED_IN' && session) {
              authLanding.value = false;
              showPasswordUpdate.value = false;
              showAuth.value = false;
              magicSent.value = false;
              await loadUserProfile(session.user.id);
              await loadAll();
              await loadNotifications();
              if (isAdmin.value) { await loadAdminUsers(); await loadShoppers(); }
              await loadAddresses();
              // Welcome / onboarding
              const isNewish = !profile.value?.avatar_url && !profile.value?.phone;
              if (isNewish) startOnboarding();
              else toast('ok','Welcome back!', profile.value?.full_name || session.user.email || '');

            } else if (event === 'TOKEN_REFRESHED' && session) {
              // Silent token refresh -- just reload data quietly
              if (!profile.value) await loadUserProfile(session.user.id);
              await loadAll();

            } else if (event === 'SIGNED_OUT') {
              profile.value = null;
              notifications.value = [];
              addresses.value = [];
              allRequests.value = [];
              payments.value = [];
              tab.value = 'home';

            } else if (event === 'INITIAL_SESSION') {
              // Page load with no session -- just load public data
              if (!session) {
                await loadAll();
              }
              // If session exists, SIGNED_IN fires separately
            }
          } catch(e) {
            console.error('[TML auth]', event, e);
          } finally {
            loading.value = false;
          }
        });
      });

      return {
        loading, loadMsg, authLanding, authLandingMsg, showPasswordUpdate, newPassword, newPasswordErr, platform, tab, sidebarOpen, globalSearch,
        basket, showBasket, basketTotal, basketCount, addToBasket, removeFromBasket, clearBasket, submitBasket,
        showOnboarding, onboardStep, onboardingDone, obF, profileCompletion,
        products, allRequests, payments, profile, notifications, adminUsers, shoppers, addresses, analyticsData, productReviews,
        usdToTzs, rateSource, rateUpdatedAt, rateAge,
        showAuth, showProfileModal, showListingModal, showReqModal, showNotifPanel, showUserPanel,
        showQuoteModal, showReviewModal, showShopperModal, showTcModal, showVerifyModal, showCancelModal, cancelReq, cancelReason, showInquiryDetail, inquiryReq, showAdminUserModal, adminViewUser, adminEditingUser, adminUF,
        editingProd, editingShopper, detailReq, paymentReq, quoteReq, reviewReq,
        viewedProduct, showProductDetail, pdReviews, pdLoading, pd3dMode, lpCarousel, trackId, trackedReq, confirm, openStatusMenu, assignShopperId, addingAddress,
        authTab, authErr, magicSent, tcAccepted, rateLimitUntil, rateLimitSecs,
        aF, pF, rF, uF, pmtF, qF, reviewF, shF, addrF,
        adminSubTab, adminReqSearch, adminReqFilter, adminPlatFilter, adminUserSearch, adminUserRoleFilter, filteredAdminUsers, appLogoUrl,
        prodSearch, prodFilter, prodTypeFilter, sortProd, filterTmda, filterInStock, prodPage, reqPage, userPage, prodTotal, reqTotal, userTotal, PROD_PER_PAGE, REQ_PER_PAGE, USER_PER_PAGE,
        reqSearch, reqFilter, reqPlatFilter,
        toasts, statusList, stepperStages,
        isAdmin, canBuy, canSell, roleLabel, roleIcon, userVerifyStatus,
        pageTitle, primaryLabel, userInitial, today, unreadCount, uniqueCats,
        myRequests, myListings, incomingReqs, myActiveReqs, myDoneReqs,
        myTotalSpent, myBalanceDue, pendingPayCount, pendingAdminCount, avgListingPrice,
        selectedProduct, reqCostEstimate,
        filteredProds, filteredMyReqs, filteredAdminReqs, recentActivity, pStats, browseSubtitle, activeFilterCount, clearAllFilters, adminTriage,
        killToast, toast, createNotification, sendWhatsApp,
        stepCls, fStatus, sBadge,
        loadAll, loadProds, loadReqs, loadAdminUsers, loadAnalytics, loadSellerAnalytics, sellerAnalytics, sellerAnalyticsLoading,
        doLogin, doMagicLink, doPasswordReset, updatePassword, doSignup, doLogout, loadUserProfile,
        saveProfile, markAllRead, clickNotification, saveAddress, deleteAddress,
        startOnboarding, obSetRole, obSetType, obHandleAvatar, obSaveProfile, obSaveRoleDetail, obSkip, handleAvatarChange,
        setPlatform, goTab, primaryAction, performSearch, closeAllMenus, togglePanel,
        openListingModal, closeListing, handleImageChange, saveListing, toggleListingStatus, askDeleteProduct, loadProductReviews, openProductDetail,
        quickRequest, saveReq, askCancelRequest, doCancel, confirmReceipt, toggleStatusMenu, updateStatus, fetchTracking, doTrack, openDetailModal,
        askPayment, doPayment,
        openQuoteModal, sendQuote, acceptQuote, declineQuote,
        openReviewModal, saveReview,
        openShopperModal, saveShopper, assignShopper, updateShopperStatus, openInquiryDetail, acceptInquiry, acknowledgeInquiry, declineInquiry,
        requestVerification, verifyDocs, adminSaveUser,
        fNum, tzs, fDate, fDateTime, fEvent, stockLabel, stockClass, fCountdown,
      };
    }
  });

  // Tell Vue that model-viewer is a native web component, not a Vue component
  app.config.compilerOptions.isCustomElement = tag => tag === 'model-viewer';

  app.mount('#app');
})();
