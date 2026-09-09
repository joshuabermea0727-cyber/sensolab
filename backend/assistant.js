// ---------------------------------------------------------------------------
// assistant.js — proxy al modelo de IA para el asistente de SensoLab.
//
// El navegador NUNCA ve la API key: llama a POST /api/assistant y este módulo
// reenvía al proveedor con la clave del entorno. Si no hay clave, responde 200
// con un mensaje de "no configurado" para que la UI degrade con elegancia.
//
// Proveedor (se elige por las variables de entorno presentes):
//   OPENAI_API_KEY      -> OpenAI  (por defecto, modelo gpt-4o-mini)
//   ANTHROPIC_API_KEY   -> Anthropic (modelo claude-haiku-4-5-20251001)
// Overrides opcionales:
//   ASSISTANT_MODEL     -> fuerza el nombre del modelo
// ---------------------------------------------------------------------------

const MAX_TOKENS = 700;

function provider() {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

// Base de conocimiento — todo lo que el bot debe saber de SensoLab.
const SYSTEM_PROMPT = `Eres el asistente de SensoLab, en español (usa "tú").
Respondes dudas sobre la empresa y su app de forma breve, cálida y concreta. Si no
sabes algo o es soporte de una cuenta específica, dilo y sugiere escribir a
hola@sensolab.solutions. Nunca inventes precios, plazos ni políticas que no estén aquí.

QUÉ ES SENSOLAB SOLUTIONS
- Laboratorio de análisis sensorial ("Innovando la experiencia sensorial"). Diseña
  y ejecuta estudios con paneles entrenados y con consumidores para que las
  empresas desarrollen, ajusten y validen sus productos con datos reales de cómo
  se perciben (apariencia, aroma, sabor, textura, sonido).
- Servicios: análisis descriptivo (perfil sensorial cuantitativo); pruebas
  discriminativas (triangular, dúo-trío, pareada) con significancia estadística;
  estudios con consumidores (aceptación, preferencia, concepto); formación y
  certificación de panelistas; consultoría de desarrollo y reformulación de
  producto; y la plataforma SensoLab Community.
- Método: 1) definir el objetivo de negocio, 2) diseñar el estudio (tipo de prueba,
  panel, plan estadístico), 3) recolección controlada (cabina o remota, tiempos
  verificados), 4) análisis estadístico (ANOVA, PCA, mapas de preferencia),
  5) informe con recomendación accionable.
- Sectores: alimentos, bebidas, café y cacao, lácteos, panificación, cosmética,
  cuidado personal, fragancias, packaging, textiles, nutracéuticos.
- Contacto: hola@sensolab.solutions

SENSOLAB COMMUNITY (la app)
- Plataforma digital de SensoLab para escalar la evaluación sensorial: recluta,
  guía y valida participantes. Es una PWA.
- Onboarding: registro con nombre + correo, código de 6 dígitos (en la demo es
  000000), perfil sensorial (país, ciudad, restricciones, alergias, intensidad,
  si fumas) y consentimiento.
- Sesiones de los cinco sentidos: sabor, tacto, olfato, sonido, vista. Cada una da
  puntos y tiene duración mínima verificada en el servidor (terminar muy rápido se
  rechaza).
- Puntos en un ledger auditable (fuente de verdad; el total es un cache). Niveles:
  1 Aprendiz (0), 2 Catador (250), 3 Explorador (1000), 4 Curador (1400),
  5 Curador Sensorial (2200). Racha diaria. Insignias por racha, nivel o número de
  sesiones.
- Una sesión se bloquea por nivel, por prerequisito o por el perfil sensorial
  (p. ej. alergia a cítricos bloquea la prueba olfativa cítrica).
- A distancia: kit a domicilio, confirmación de recepción, checklist + foto del
  setup, sesión guiada y evidencia (foto o audio). Un integrity_score aprueba en
  automático o manda a revisión humana; nunca rechaza en automático.
- Ranking semanal por puntos, siempre te incluye.`;

// Rate limit simple en memoria: N mensajes por ventana por IP.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 25;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > MAX_PER_WINDOW;
}

async function callOpenAI(messages) {
  const model = process.env.ASSISTANT_MODEL || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0.4,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`openai ${res.status} ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function callAnthropic(messages) {
  const model = process.env.ASSISTANT_MODEL || 'claude-haiku-4-5-20251001';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status} ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

/**
 * @param {{messages: {role:'user'|'assistant', content:string}[]}} body
 * @returns {Promise<{reply:string, configured:boolean, provider?:string}>}
 */
export async function askAssistant(body, ip) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const clean = msgs
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

  const prov = provider();

  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    return { reply: 'Escribe tu pregunta y con gusto te ayudo.', configured: !!prov };
  }
  if (rateLimited(ip)) {
    return { reply: 'Vas muy rápido — espera un momento y vuelve a intentar.', configured: true };
  }
  if (!prov) {
    return {
      reply: 'El asistente de IA todavía no está configurado en este entorno. '
        + 'Cuando el equipo agregue la clave del modelo (OPENAI_API_KEY), '
        + 'podré responder tus dudas sobre SensoLab.',
      configured: false,
    };
  }

  try {
    const reply = (prov === 'openai' ? await callOpenAI(clean) : await callAnthropic(clean))
      || 'No tengo una respuesta para eso.';
    return { reply, configured: true, provider: prov };
  } catch (err) {
    console.error('assistant upstream error', String(err).slice(0, 400));
    return { reply: 'Ahora mismo no puedo responder. Intenta de nuevo en un momento.', configured: true };
  }
}
