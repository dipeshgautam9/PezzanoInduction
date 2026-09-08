// app.js — Corrected application logic for Pezzano Induction
// Live schema tables: employees, module_progress, product_photos, product_confirmations, product_media, employee_documents, departments, positions, audit_logs

const SUPABASE_URL = window.SUPABASE_URL || "https://jookdsjvbticdgvxagyt.supabase.co";
const SUPABASE_KEY = window.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_1emkeuRvXdsF6S-yyxcUeQ_BdUBJ5PF";

function getSupabaseClient() {
  if (window.supabase && window.supabase.createClient) {
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  throw new Error("Supabase JS client not loaded. Include the Supabase script before app.js.");
}

// ---------- Auth & Employee ----------

async function signUpEmployee({ employee_code, full_name, email, password, department, position, work_location }) {
  const client = getSupabaseClient();
  // Create auth user
  const { data: authData, error: authError } = await client.auth.signUp({
    email,
    password,
    options: {
      data: { employee_code, full_name }
    }
  });
  if (authError || !authData?.user) throw authError || new Error("Signup failed");

  // Create employee row linked via auth_id
  const { error: empError } = await client.from("employees").insert({
    auth_id: authData.user.id,
    employee_code,
    full_name,
    email,
    department: department || "General",
    position: position || "Team Member",
    work_location: work_location || "Canning Vale",
    role: "employee",
    completion_status: "pending",
    progress_pct: 0
  });
  if (empError) {
    // Optionally delete auth user or leave orphan; here we just throw
    throw empError;
  }
  return authData.user;
}

async function signIn(email, password) {
  const client = getSupabaseClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signOut() {
  const client = getSupabaseClient();
  await client.auth.signOut();
  window.clearSession?.();
}

// ---------- Modules & Progress ----------

async function getModuleProgress(employeeId) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("module_progress")
    .select("id, employee_id, module_id, answers, completed, completed_at, created_at, updated_at")
    .eq("employee_id", employeeId);
  if (error) throw error;
  return data || [];
}

async function saveModuleAnswer({ employee_id, module_id, answers }) {
  const client = getSupabaseClient();
  // Upsert: if exists update answers, else insert
  const { data: existing } = await client
    .from("module_progress")
    .select("id")
    .eq("employee_id", employee_id)
    .eq("module_id", module_id)
    .limit(1)
    .single();

  if (existing) {
    const { data, error } = await client
      .from("module_progress")
      .update({ answers, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } else {
    const { data, error } = await client
      .from("module_progress")
      .insert({ employee_id, module_id, answers, completed: false })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

async function completeModule({ employee_id, module_id }) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("module_progress")
    .upsert(
      { employee_id, module_id, completed: true, completed_at: new Date().toISOString() },
      { onConflict: "employee_id,module_id" }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------- Product Photos & Confirmations ----------

async function getProductPhotos(filters = {}) {
  const client = getSupabaseClient();
  let q = client
    .from("product_photos")
    .select("id, name, department, category, description, image_path, reject_image_path, reject_note, is_essential, keywords, sort_order, created_at, updated_at");

  if (filters.department) q = q.eq("department", filters.department);
  if (filters.category) q = q.eq("category", filters.category);
  if (typeof filters.is_essential === "boolean") q = q.eq("is_essential", filters.is_essential);

  const { data, error } = await q.order("sort_order", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function confirmProduct({ employee_id, product_id, correct = true }) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("product_confirmations")
    .insert({ employee_id, product_id, correct, confirmed_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getProductMedia(productId) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("product_media")
    .select("id, product_id, media_type, file_path, sort_order, uploaded_by, created_at")
    .eq("product_id", productId)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return data || [];
}

// ---------- Employee Documents ----------

async function uploadEmployeeDocument({ employee_id, doc_type, doc_subtype, doc_number, expiry_date, file_name, file_path, notes }) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("employee_documents")
    .insert({
      employee_id,
      doc_type,
      doc_subtype,
      doc_number,
      expiry_date,
      file_name,
      file_path,
      notes
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getEmployeeDocuments(employee_id) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("employee_documents")
    .select("id, employee_id, doc_type, doc_subtype, doc_number, expiry_date, file_name, file_path, notes, uploaded_at, uploaded_by")
    .eq("employee_id", employee_id);
  if (error) throw error;
  return data || [];
}

// ---------- Departments & Positions ----------

async function getDepartments() {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("departments")
    .select("id, name, visible_in_library, created_at")
    .eq("visible_in_library", true)
    .order("name", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getPositions() {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("positions")
    .select("id, name, created_at")
    .order("name", { ascending: true });
  if (error) throw error;
  return data || [];
}

// ---------- Audit Logs ----------

async function logAudit({ actor_id, actor_name, actor_role, target_id, action, detail, old_value, new_value }) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("audit_logs")
    .insert({ actor_id, actor_name, actor_role, target_id, action, detail, old_value, new_value })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------- Helpers ----------

async function updateEmployeeProgress(employee_id, progress_pct, knowledge_viewed = []) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("employees")
    .update({ progress_pct, knowledge_viewed, updated_at: new Date().toISOString() })
    .eq("id", employee_id)
    .select("id, progress_pct, knowledge_viewed, completion_status")
    .single();
  if (error) throw error;
  return data;
}

// Expose to window for HTML usage
if (typeof window !== "undefined") {
  window.signUpEmployee = signUpEmployee;
  window.signIn = signIn;
  window.signOut = signOut;
  window.getModuleProgress = getModuleProgress;
  window.saveModuleAnswer = saveModuleAnswer;
  window.completeModule = completeModule;
  window.getProductPhotos = getProductPhotos;
  window.confirmProduct = confirmProduct;
  window.getProductMedia = getProductMedia;
  window.uploadEmployeeDocument = uploadEmployeeDocument;
  window.getEmployeeDocuments = getEmployeeDocuments;
  window.getDepartments = getDepartments;
  window.getPositions = getPositions;
  window.logAudit = logAudit;
  window.updateEmployeeProgress = updateEmployeeProgress;
}