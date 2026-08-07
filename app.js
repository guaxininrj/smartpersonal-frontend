function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useState,
  useEffect,
  useMemo,
  useRef
} = React;
console.log("[SmartPersonal] build carregado: diagnóstico ExerciseDB v5 (com intervalo entre chamadas)");

/* ---------- localStorage hook ---------- */
const PREFIX = "smartpersonal:";

/* correção única: remove sessões de treino já salvas no navegador que
   ficaram com 0 exercícios concluídos (resquício de uma versão anterior
   que contava o treino como "realizado" com uma única série avulsa
   marcada, sem nenhum exercício completo). Roda antes de qualquer tela
   (Dashboard, Estatísticas, Planos de Treino) ler os dados, pra garantir
   que todas fiquem corretas desde o primeiro render. */
(function limparSessoesZeradas() {
  try {
    const chave = PREFIX + "treinos-log";
    const raw = window.localStorage.getItem(chave);
    if (!raw) return;
    const sessoes = JSON.parse(raw);
    if (!Array.isArray(sessoes)) return;
    const limpo = sessoes.filter(s => s && s.exercicios && s.exercicios.length > 0);
    if (limpo.length !== sessoes.length) {
      window.localStorage.setItem(chave, JSON.stringify(limpo));
    }
  } catch (e) {}
})();
/* ---------- sincronismo com a nuvem ----------

   O localStorage continua sendo a fonte que as telas leem: é instantâneo e
   funciona offline (o app é instalável). A nuvem é um espelho por cima disso.

   Fluxo: a tela grava no localStorage como sempre -> o valor entra numa fila
   -> a fila sobe pro servidor -> o servidor avisa os OUTROS aparelhos por
   WebSocket -> lá o valor cai no localStorage e a tela correspondente
   re-renderiza. Sem internet nada trava: a fila fica guardada e sobe depois.  */

const API = "https://api.smartpersonal.smartlinkdigital.com.br";
const CHAVE_TOKEN = PREFIX + "_token";
const CHAVE_FILA = PREFIX + "_fila";
const CHAVE_CLIENTE = PREFIX + "_cliente";

/* chaves internas do sincronismo não são dados do usuário e não devem ser
   sincronizadas — senão um aparelho mandaria o próprio token pro outro. */
const CHAVES_INTERNAS = ["_token", "_fila", "_cliente"];
const nuvem = {
  token: null,
  clienteId: null,
  ws: null,
  timers: {},
  // chave -> timer do debounce
  assinantes: new Map(),
  // chave -> Set de callbacks (os hooks das telas)
  aoMudarLogin: null,
  iniciar() {
    try {
      this.token = window.localStorage.getItem(CHAVE_TOKEN);
      this.clienteId = window.localStorage.getItem(CHAVE_CLIENTE);
      if (!this.clienteId) {
        // identifica ESTE aparelho, pra ele não receber de volta o eco do que
        // ele mesmo acabou de escrever
        this.clienteId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        window.localStorage.setItem(CHAVE_CLIENTE, this.clienteId);
      }
    } catch (e) {}
    window.addEventListener("online", () => this.descarregarFila());
    setInterval(() => this.descarregarFila(), 20000);
  },
  logado() {
    return !!this.token;
  },
  cabecalhos() {
    const h = {
      "Content-Type": "application/json",
      "X-Cliente-Id": this.clienteId
    };
    if (this.token) h["Authorization"] = "Bearer " + this.token;
    return h;
  },
  async pedir(caminho, opcoes) {
    const resp = await fetch(API + caminho, {
      ...opcoes,
      headers: this.cabecalhos()
    });
    const texto = await resp.text();
    let corpo = null;
    try {
      corpo = texto ? JSON.parse(texto) : null;
    } catch (e) {}
    if (!resp.ok) {
      const erro = new Error(corpo && corpo.erro || "Erro de conexão");
      erro.status = resp.status;
      erro.corpo = corpo;
      throw erro;
    }
    return corpo;
  },
  async entrar(email, senha) {
    const r = await this.pedir("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email,
        senha
      })
    });
    return this.aposEntrar(r);
  },
  async cadastrar(nome, email, senha) {
    const r = await this.pedir("/auth/cadastro", {
      method: "POST",
      body: JSON.stringify({
        nome,
        email,
        senha
      })
    });
    return this.aposEntrar(r);
  },
  async aposEntrar(r) {
    this.token = r.token;
    try {
      window.localStorage.setItem(CHAVE_TOKEN, r.token);
    } catch (e) {}
    await this.primeiraSincronizacao();
    this.conectar();
    return r.aluno;
  },
  sair() {
    this.token = null;
    try {
      window.localStorage.removeItem(CHAVE_TOKEN);
      // apaga os dados locais: outra pessoa entrando neste aparelho não pode
      // ver os treinos de quem saiu.
      listarChavesApp().forEach(k => window.localStorage.removeItem(k));
      window.localStorage.removeItem(CHAVE_FILA);
    } catch (e) {}
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    window.location.reload();
  },
  /* Primeiro login neste aparelho: junta o que existe dos dois lados.
     A nuvem manda no empate — é ela que tem o histórico de todos os aparelhos.
     O que só existe aqui (dados criados antes de ter conta) sobe. */
  async primeiraSincronizacao() {
    let daNuvem = {};
    try {
      const r = await this.pedir("/storage", {
        method: "GET"
      });
      daNuvem = r && r.dados || {};
    } catch (e) {
      if (e.status === 401) throw e;
      return; // sem internet: segue com o que tem local, a fila resolve depois
    }
    const daquiSoLocal = {};
    listarChavesApp().forEach(k => {
      const chave = k.slice(PREFIX.length);
      if (CHAVES_INTERNAS.indexOf(chave) >= 0) return;
      if (Object.prototype.hasOwnProperty.call(daNuvem, chave)) return;
      try {
        daquiSoLocal[chave] = window.localStorage.getItem(k);
      } catch (e) {}
    });
    Object.keys(daNuvem).forEach(chave => {
      try {
        window.localStorage.setItem(PREFIX + chave, textoDoValor(daNuvem[chave]));
      } catch (e) {}
    });
    if (Object.keys(daquiSoLocal).length > 0) {
      try {
        await this.pedir("/storage/lote", {
          method: "POST",
          body: JSON.stringify({
            dados: daquiSoLocal
          })
        });
      } catch (e) {
        Object.keys(daquiSoLocal).forEach(c => this.enfileirar(c, daquiSoLocal[c]));
      }
    }
  },
  /* debounce por chave: digitar o peso de uma série dispara muitos setState
     seguidos, e não faz sentido mandar uma requisição por tecla. */
  salvar(chave, valorTexto) {
    if (!this.token || CHAVES_INTERNAS.indexOf(chave) >= 0) return;
    clearTimeout(this.timers[chave]);
    this.timers[chave] = setTimeout(() => {
      this.pedir("/storage", {
        method: "POST",
        body: JSON.stringify({
          chave,
          valor: valorTexto
        })
      }).catch(() => this.enfileirar(chave, valorTexto));
    }, 600);
  },
  lerFila() {
    try {
      return JSON.parse(window.localStorage.getItem(CHAVE_FILA) || "{}");
    } catch (e) {
      return {};
    }
  },
  gravarFila(fila) {
    try {
      window.localStorage.setItem(CHAVE_FILA, JSON.stringify(fila));
    } catch (e) {}
  },
  enfileirar(chave, valorTexto) {
    const fila = this.lerFila();
    fila[chave] = valorTexto; // só o valor mais recente importa
    this.gravarFila(fila);
  },
  async descarregarFila() {
    if (!this.token || !navigator.onLine) return;
    const fila = this.lerFila();
    const chaves = Object.keys(fila);
    if (chaves.length === 0) return;
    try {
      await this.pedir("/storage/lote", {
        method: "POST",
        body: JSON.stringify({
          dados: fila
        })
      });
      // só apaga o que foi enviado: pode ter entrado coisa nova na fila
      // enquanto a requisição estava no ar.
      const agora = this.lerFila();
      chaves.forEach(c => {
        if (agora[c] === fila[c]) delete agora[c];
      });
      this.gravarFila(agora);
    } catch (e) {}
  },
  conectar() {
    if (!this.token || this.ws) return;
    let url = API.replace(/^http/, "ws") + "/tempo-real?token=" + encodeURIComponent(this.token) + "&clienteId=" + encodeURIComponent(this.clienteId);
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      return;
    }
    this.ws.onopen = () => this.descarregarFila();
    this.ws.onmessage = ev => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.tipo !== "mudou") return;
      const texto = msg.valor === null ? null : textoDoValor(msg.valor);
      try {
        if (texto === null) window.localStorage.removeItem(PREFIX + msg.chave);else window.localStorage.setItem(PREFIX + msg.chave, texto);
      } catch (e) {}
      this.avisarTelas(msg.chave, texto);
    };
    this.ws.onclose = () => {
      this.ws = null;
      // reconecta sozinho: celular que dormiu ou wi-fi que caiu não pode
      // deixar o aparelho mudo até a pessoa recarregar a página.
      if (this.token) setTimeout(() => this.conectar(), 5000);
    };
    this.ws.onerror = () => {
      try {
        this.ws.close();
      } catch (e) {}
    };
  },
  inscrever(chave, callback) {
    if (!this.assinantes.has(chave)) this.assinantes.set(chave, new Set());
    this.assinantes.get(chave).add(callback);
    return () => {
      const s = this.assinantes.get(chave);
      if (!s) return;
      s.delete(callback);
      if (s.size === 0) this.assinantes.delete(chave);
    };
  },
  avisarTelas(chave, texto) {
    const s = this.assinantes.get(chave);
    if (!s) return;
    s.forEach(cb => {
      try {
        cb(texto);
      } catch (e) {}
    });
  }
};

/* O servidor pode devolver o valor já como objeto (coluna jsonb) ou como
   texto (coluna text). Normaliza pra sempre virar o texto JSON que o
   localStorage guarda, sem depender de qual dos dois é. */
function textoDoValor(valor) {
  return typeof valor === "string" ? valor : JSON.stringify(valor);
}
nuvem.iniciar();
function useLocalStorage(key, initialValue) {
  const fullKey = PREFIX + key;
  const interpretar = texto => {
    if (texto === null || texto === undefined) return initialValue;
    try {
      const parsed = JSON.parse(texto);
      // se o valor salvo for um objeto "simples", mescla com o valor inicial
      // para garantir que campos novos adicionados depois (ex: pesoObjetivo)
      // sempre tenham um valor padrão, mesmo em dados salvos antes de existirem.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && initialValue && typeof initialValue === "object" && !Array.isArray(initialValue)) {
        return {
          ...initialValue,
          ...parsed
        };
      }
      return parsed;
    } catch (e) {
      return initialValue;
    }
  };
  const [value, setValue] = useState(() => {
    try {
      return interpretar(window.localStorage.getItem(fullKey));
    } catch (e) {
      return initialValue;
    }
  });

  /* Marca as gravações vindas do outro aparelho pra não devolvê-las pra nuvem:
     sem isso, receber uma mudança dispararia um novo envio, e os dois
     aparelhos ficariam ecoando um pro outro. */
  const veioDeFora = useRef(false);
  useEffect(() => {
    return nuvem.inscrever(key, texto => {
      veioDeFora.current = true;
      setValue(interpretar(texto));
    });
  }, [key]);
  useEffect(() => {
    const texto = JSON.stringify(value);
    try {
      window.localStorage.setItem(fullKey, texto);
    } catch (e) {}
    if (veioDeFora.current) {
      veioDeFora.current = false;
      return;
    }
    nuvem.salvar(key, texto);
  }, [fullKey, value]);
  return [value, setValue];
}

/* ---------- celebração: som, confete e card grande ---------- */
let _audioCtx = null;
function _getAudioCtx() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    return _audioCtx;
  } catch (e) {
    return null;
  }
}
/* toca uma sequência de notas simples via osciladores — sem depender de nenhum arquivo de áudio */
function _tocarNotas(notas) {
  const ctx = _getAudioCtx();
  if (!ctx) return;
  const agora = ctx.currentTime;
  notas.forEach(([freq, inicio, duracao, tipo]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tipo || "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, agora + inicio);
    gain.gain.linearRampToValueAtTime(0.18, agora + inicio + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, agora + inicio + duracao);
    osc.connect(gain).connect(ctx.destination);
    osc.start(agora + inicio);
    osc.stop(agora + inicio + duracao + 0.02);
  });
}
/* jingle de conquista desbloqueada: arpejo ascendente + nota final brilhante */
function tocarSomConquista() {
  _tocarNotas([[523.25, 0, 0.14, "triangle"], [659.25, 0.1, 0.14, "triangle"], [783.99, 0.2, 0.16, "triangle"], [1046.5, 0.32, 0.4, "sine"]]);
}
/* ding curto e forte pra recorde pessoal (PR) */
function tocarSomRecorde() {
  _tocarNotas([[880, 0, 0.12, "square"], [1174.66, 0.09, 0.28, "sine"]]);
}
const CONFETE_CORES = ["#d60000", "#ff4d4d", "#f59e0b", "#22c55e", "#eab308", "#ffffff"];
function Confete({
  quantidade
}) {
  const particulas = useMemo(() => Array.from({
    length: quantidade || 60
  }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    cor: CONFETE_CORES[Math.floor(Math.random() * CONFETE_CORES.length)],
    atraso: Math.random() * 0.4,
    duracao: 1.8 + Math.random() * 1.4,
    largura: 5 + Math.random() * 6,
    girado: Math.random() > 0.5
  })), [quantidade]);
  return /*#__PURE__*/React.createElement("div", {
    className: "pointer-events-none fixed inset-0 z-[70] overflow-hidden"
  }, particulas.map(p => /*#__PURE__*/React.createElement("span", {
    key: p.id,
    className: "confete-particula",
    style: {
      left: p.left + "vw",
      width: p.largura + "px",
      background: p.cor,
      borderRadius: p.girado ? "50%" : "1px",
      animationDelay: p.atraso + "s",
      animationDuration: p.duracao + "s"
    }
  })));
}

/* card grande de celebração — usado tanto pra conquistas desbloqueadas quanto
   pra recordes pessoais (PR). fecha sozinho depois de alguns segundos ou ao tocar. */
function CelebracaoOverlay({
  tipo,
  icon,
  titulo,
  subtitulo,
  detalhe,
  onFechar
}) {
  useEffect(() => {
    if (tipo === "conquista") tocarSomConquista();else tocarSomRecorde();
    const id = setTimeout(onFechar, 4200);
    return () => clearTimeout(id);
  }, []);
  const corTopo = tipo === "conquista" ? "#f59e0b" : "#d60000";
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[65] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm fade-up",
    onClick: onFechar
  }, /*#__PURE__*/React.createElement(Confete, {
    quantidade: tipo === "conquista" ? 90 : 55
  }), /*#__PURE__*/React.createElement("div", {
    className: "celebracao-card card relative flex max-w-sm flex-col items-center gap-3 p-8 text-center",
    style: {
      borderTop: "3px solid " + corTopo
    },
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("span", {
    className: "celebracao-icone flex h-20 w-20 items-center justify-center rounded-full bg-surface2 text-4xl border",
    style: {
      borderColor: corTopo
    }
  }, icon), /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow",
    style: {
      color: corTopo
    }
  }, tipo === "conquista" ? "Conquista desbloqueada" : "Novo recorde pessoal"), /*#__PURE__*/React.createElement("h2", {
    className: "font-display text-xl font-semibold text-text"
  }, titulo), subtitulo && /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, subtitulo), detalhe && /*#__PURE__*/React.createElement("p", {
    className: "tabular text-sm font-medium text-textFaint"
  }, detalhe), /*#__PURE__*/React.createElement("button", {
    className: "mt-2 rounded-md border border-border px-4 py-1.5 text-xs font-medium text-textMuted hover:border-red hover:text-red",
    onClick: onFechar
  }, "Continuar")));
}

/* ---------- calculations ---------- */
function calcularIMC(pesoKg, alturaCm) {
  const alturaM = alturaCm / 100;
  if (!pesoKg || !alturaM) return null;
  return pesoKg / (alturaM * alturaM);
}
function classificarIMC(imc) {
  if (imc == null) return "-";
  if (imc < 18.5) return "Abaixo do peso";
  if (imc < 25) return "Peso normal";
  if (imc < 30) return "Sobrepeso";
  if (imc < 35) return "Obesidade grau I";
  if (imc < 40) return "Obesidade grau II";
  return "Obesidade grau III";
}
function calcularPesoIdeal(alturaCm, sexo) {
  if (!alturaCm) return null;
  const alturaIn = alturaCm / 2.54;
  const polegadasAcima152 = Math.max(alturaIn - 60, 0);
  const base = sexo === "feminino" ? 45.5 : 50;
  return base + 2.3 * polegadasAcima152;
}
function calcularTMB(pesoKg, alturaCm, idade, sexo) {
  if (!pesoKg || !alturaCm || !idade) return null;
  const base = 10 * pesoKg + 6.25 * alturaCm - 5 * idade;
  return sexo === "feminino" ? base - 161 : base + 5;
}

/* ---------- banco de exercícios (15 por grupo) ---------- */
const GRUPOS_MUSCULARES = ["Peito", "Costas", "Ombros", "Bíceps", "Tríceps", "Pernas", "Quadríceps", "Posterior", "Glúteos", "Panturrilhas", "Abdômen", "Antebraço", "Trapézio", "Lombar", "Core"];
const EXERCICIOS_POR_GRUPO = {
  "Peito": ["Supino Reto", "Supino Inclinado", "Supino Declinado", "Supino com Halteres", "Crucifixo Reto", "Crucifixo Inclinado", "Cross Over", "Peck Deck", "Flexão de Braço", "Pullover", "Máquina Voadora", "Supino Máquina", "Flexão com Peso", "Crossover Baixo", "Press de Peito"],
  "Costas": ["Puxada Frontal", "Puxada Aberta", "Remada Curvada", "Remada Cavalinho", "Remada Baixa", "Remada Unilateral", "Barra Fixa", "Pulldown", "Levantamento Terra", "Remada Máquina", "Puxada Triângulo", "Remada com Halteres", "Face Pull", "Hiperextensão", "Puxada Neutra"],
  "Ombros": ["Desenvolvimento Militar", "Desenvolvimento com Halteres", "Elevação Lateral", "Elevação Frontal", "Remada Alta", "Crucifixo Invertido", "Arnold Press", "Desenvolvimento Máquina", "Elevação Lateral no Cabo", "Face Pull", "Encolhimento", "Desenvolvimento Smith", "Elevação Lateral Sentado", "Manguito Rotador", "Push Press"],
  "Bíceps": ["Rosca Direta", "Rosca Alternada", "Rosca Martelo", "Rosca Scott", "Rosca Concentrada", "Rosca 21", "Rosca no Cabo", "Rosca Inversa", "Rosca Banco Inclinado", "Rosca de Punho", "Rosca na Barra W", "Rosca Unilateral no Cabo", "Rosca Sentado", "Rosca Spider", "Rosca Zottman"],
  "Tríceps": ["Tríceps Testa", "Tríceps Corda", "Tríceps Francês", "Tríceps Coice", "Mergulho no Banco", "Tríceps Pulley Barra", "Supino Fechado", "Coice Unilateral", "Extensão com Halteres", "Tríceps no Banco", "Kickback no Cabo", "Tríceps Máquina", "Mergulho em Paralelas", "Extensão Testa Halteres", "Tríceps Corda Overhead"],
  "Pernas": ["Agachamento Livre", "Leg Press", "Cadeira Extensora", "Cadeira Flexora", "Afundo", "Agachamento Búlgaro", "Agachamento Smith", "Leg Press 45", "Passada", "Agachamento Sumô", "Step Up", "Agachamento Hack", "Cadeira Adutora", "Cadeira Abdutora", "Agachamento Frontal"],
  "Quadríceps": ["Cadeira Extensora", "Agachamento Livre", "Leg Press", "Agachamento Frontal", "Hack Squat", "Afundo", "Agachamento Búlgaro", "Passada com Halteres", "Agachamento Smith", "Step Up", "Agachamento Sissy", "Leg Press Unilateral", "Agachamento Taça", "Extensora Unilateral", "Agachamento Overhead"],
  "Posterior": ["Mesa Flexora", "Cadeira Flexora", "Stiff", "Terra Romeno", "Good Morning", "Flexora em Pé", "Flexora Unilateral", "Terra Sumô", "Ponte Nórdica", "Elevação Pélvica", "Flexora Sentado", "Stiff com Halteres", "Flexora Deitado", "Flexora com Bola Suíça", "Terra Romeno Unilateral"],
  "Glúteos": ["Elevação Pélvica", "Agachamento Sumô", "Cadeira Abdutora", "Coice no Cabo", "Coice na Máquina", "Ponte de Glúteos", "Agachamento Búlgaro", "Passada", "Step Up", "Elevação Pélvica com Barra", "Abdução de Quadril", "Glúteo na Polia", "Agachamento Sumô com Halteres", "Extensão de Quadril", "Frog Pump"],
  "Panturrilhas": ["Panturrilha em Pé", "Panturrilha Sentado", "Panturrilha no Leg Press", "Panturrilha Unilateral", "Panturrilha na Smith", "Panturrilha no Step", "Panturrilha na Máquina", "Elevação de Calcanhar", "Panturrilha com Halteres", "Panturrilha Burrinho", "Panturrilha na Barra", "Panturrilha Isométrica", "Panturrilha Explosiva", "Panturrilha Unilateral com Halter", "Panturrilha na Prensa"],
  "Abdômen": ["Abdominal Supra", "Abdominal Infra", "Prancha", "Abdominal Bicicleta", "Abdominal na Máquina", "Elevação de Pernas", "Abdominal Oblíquo", "Abdominal Canivete", "Prancha Lateral", "Abdominal na Polia", "Abdominal Remador", "Abdominal com Peso", "Mountain Climber", "Abdominal no TRX", "Roda Abdominal"],
  "Antebraço": ["Rosca de Punho", "Rosca de Punho Inversa", "Flexão de Punho", "Extensão de Punho", "Rosca Antebraço com Barra", "Farmer Walk", "Rosca de Punho com Halteres", "Pinça com Disco", "Enrolamento na Barra", "Rosca Reversa", "Rosca de Punho Unilateral", "Extensor de Pulso", "Hand Grip", "Rosca Antebraço no Banco", "Suspensão na Barra"],
  "Trapézio": ["Encolhimento com Barra", "Encolhimento com Halteres", "Remada Alta", "Encolhimento na Smith", "Face Pull", "Levantamento Terra", "Remada Cavalinho", "Encolhimento no Cabo", "Encolhimento com Elástico", "Remada Alta no Cabo", "Encolhimento Unilateral", "Farmer Walk", "Clean Pull", "Encolhimento Atrás das Costas", "Remada para Trapézio"],
  "Lombar": ["Hiperextensão", "Levantamento Terra", "Good Morning", "Superman", "Extensão Lombar na Máquina", "Stiff", "Ponte de Glúteos", "Terra Romeno", "Banco Reverso", "Extensão de Tronco", "Terra Sumô", "Prancha", "Hiperextensão com Peso", "Bird Dog", "Extensão Lombar 45°"],
  "Core": ["Prancha", "Prancha Lateral", "Abdominal Bicicleta", "Mountain Climber", "Ab Wheel", "Pallof Press", "Russian Twist", "Dead Bug", "Hollow Hold", "Prancha com Elevação de Perna", "Bird Dog", "Abdominal na Bola Suíça", "Prancha Dinâmica", "Woodchopper", "Abdominal Remador"]
};
const DIAS_SEMANA = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];

/* ---------- helpers de semana (segunda a domingo) ---------- */
function inicioDaSemana(referencia = new Date()) {
  const d = new Date(referencia);
  d.setHours(0, 0, 0, 0);
  const diaJs = d.getDay(); // 0 = domingo
  const offset = diaJs === 0 ? 6 : diaJs - 1; // dias desde a última segunda
  d.setDate(d.getDate() - offset);
  return d;
}
function dataDoDiaNaSemana(diaLabel, referencia = new Date()) {
  const idx = DIAS_SEMANA.indexOf(diaLabel);
  const segunda = inicioDaSemana(referencia);
  const data = new Date(segunda);
  data.setDate(segunda.getDate() + idx);
  return data;
}
const MET_POR_GRUPO = {
  Peito: 5,
  Costas: 5,
  Ombros: 4.5,
  "Bíceps": 3.5,
  "Tríceps": 3.5,
  Pernas: 6,
  "Quadríceps": 6,
  Posterior: 5.5,
  "Glúteos": 5.5,
  Panturrilhas: 4,
  "Abdômen": 4,
  Antebraço: 3,
  "Trapézio": 4,
  Lombar: 4,
  Core: 4.5
};
function estimarCaloriasExercicio({
  pesoKg,
  grupoMuscular,
  cargaKg = 0,
  series = 0,
  repeticoes = 0,
  descansoSegundos = 60
}) {
  if (!pesoKg) return 0;
  const met = MET_POR_GRUPO[grupoMuscular] ?? 4.5;
  const tempoAtivoMin = series * repeticoes * 3.5 / 60;
  const tempoDescansoMin = series * descansoSegundos / 60;
  const tempoTotalMin = tempoAtivoMin + tempoDescansoMin * 0.4;
  const fatorCarga = 1 + Math.min(cargaKg / 100, 0.6);
  const caloriasPorMinuto = met * 3.5 * pesoKg / 200;
  return Math.round(caloriasPorMinuto * tempoTotalMin * fatorCarga);
}

/* ---------- Biblioteca de exercícios: descrição de execução ---------- */
/* Gera uma orientação de execução com base em padrões de movimento reconhecidos
   pelo nome do exercício (compostos, isolados, dobradiça de quadril, etc.),
   já que manter uma descrição manual única para 200+ exercícios seria inviável. */
const PADROES_EXECUCAO = [{
  testar: n => /supino|press|desenvolvimento|push press/i.test(n) && !/flexão de braço/i.test(n),
  execucao: "Posicione a carga na altura do peito/ombros, mantenha os punhos alinhados com os cotovelos e empurre até a extensão quase completa, sem travar bruscamente.",
  dica: "Mantenha as escápulas retraídas e os pés firmes no chão (ou banco) durante todo o movimento.",
  erro: "Deixar os cotovelos abrirem demais para os lados, sobrecarregando o ombro."
}, {
  testar: n => /rosca/i.test(n),
  execucao: "Com os cotovelos próximos ao tronco, flexione o cotovelo levando a carga em direção ao ombro, controlando a descida.",
  dica: "Evite balançar o tronco para 'ajudar' o movimento — isso tira a tensão do músculo alvo.",
  erro: "Descer a carga rápido demais, perdendo a fase excêntrica do movimento."
}, {
  testar: n => /puxada|remada|pulldown|barra fixa/i.test(n),
  execucao: "Puxe a carga (ou o próprio corpo) em direção ao tronco, levando os cotovelos para trás e aproximando as escápulas.",
  dica: "Inicie o movimento pelas costas, não pelos braços — pense em 'puxar com os cotovelos'.",
  erro: "Usar impulso do corpo (embalo) para completar a puxada."
}, {
  testar: n => /agachamento|leg press|afundo|passada|step up|hack/i.test(n),
  execucao: "Desça controlando o quadril para trás e para baixo, joelhos alinhados com a linha dos pés, até a amplitude confortável, e suba empurrando o chão.",
  dica: "Mantenha o peso distribuído no meio/calcanhar do pé e o tronco estável.",
  erro: "Deixar os joelhos 'caírem' para dentro durante a subida."
}, {
  testar: n => /terra|stiff|good morning/i.test(n),
  execucao: "Com leve flexão de joelhos, incline o tronco à frente projetando o quadril para trás (dobradiça de quadril), mantendo a coluna neutra, e retorne à posição inicial.",
  dica: "Mantenha a barra/halteres próximos às pernas durante todo o percurso.",
  erro: "Arredondar as costas para buscar mais amplitude."
}, {
  testar: n => /cadeira flexora|mesa flexora|flexora/i.test(n),
  execucao: "Flexione o joelho trazendo o calcanhar em direção ao glúteo, controlando a volta à posição inicial.",
  dica: "Evite tirar o quadril do apoio durante a flexão.",
  erro: "Usar amplitude parcial e velocidade excessiva."
}, {
  testar: n => /cadeira extensora|extensora|extensão de tronco|extensão lombar/i.test(n),
  execucao: "Estenda a articulação alvo (joelho, quadril ou tronco, conforme o exercício) de forma controlada até a amplitude máxima confortável, sem travar bruscamente.",
  dica: "Controle a fase de retorno — não deixe a carga 'cair'.",
  erro: "Usar amplitude parcial só na parte mais fácil do movimento."
}, {
  testar: n => /elevação|abdução|glúteo na polia|coice/i.test(n),
  execucao: "Eleve o membro (braço, perna ou quadril) contra a resistência até a altura indicada, com controle, e retorne sem soltar a tensão.",
  dica: "Priorize amplitude e controle em vez de carga alta.",
  erro: "Usar embalo/impulso para levantar a carga."
}, {
  testar: n => /encolhimento/i.test(n),
  execucao: "Eleve os ombros em direção às orelhas sem rodar, segure brevemente no topo e desça controlando.",
  dica: "Evite rolar os ombros — o movimento é reto para cima e para baixo.",
  erro: "Usar os braços para 'ajudar', tirando o trabalho do trapézio."
}, {
  testar: n => /panturrilha/i.test(n),
  execucao: "A partir da posição neutra do tornozelo, eleve os calcanhares o máximo possível e desça até alongar bem a panturrilha.",
  dica: "Faça o movimento devagar, principalmente na descida.",
  erro: "Usar amplitude curta, sem alongar no fim do movimento."
}, {
  testar: n => /prancha|hollow|pallof|bird dog|dead bug/i.test(n),
  execucao: "Mantenha a posição isométrica com o core contraído, coluna neutra e respiração controlada pelo tempo determinado.",
  dica: "Evite deixar o quadril subir ou cair — mantenha o corpo alinhado.",
  erro: "Prender a respiração durante toda a série."
}, {
  testar: n => /abdominal|russian twist|woodchopper|mountain climber|roda abdominal|ab wheel/i.test(n),
  execucao: "Contraia o abdômen para flexionar/rotacionar o tronco de forma controlada, evitando puxar o pescoço com as mãos.",
  dica: "Pense em 'encurtar a distância entre costela e quadril' em vez de só levantar o tronco.",
  erro: "Puxar o pescoço com as mãos em vez de usar o abdômen."
}, {
  testar: n => /flexão de braço|mergulho/i.test(n),
  execucao: "Desça o corpo controlando cotovelos e tronco alinhados, até quase tocar a superfície, e empurre de volta à posição inicial.",
  dica: "Mantenha o core contraído para não deixar o quadril cair.",
  erro: "Abrir demais os cotovelos, sobrecarregando o ombro."
}, {
  testar: n => /farmer walk|hand grip|pinça com disco/i.test(n),
  execucao: "Segure a carga com firmeza e mantenha a postura ereta pelo tempo/distância determinado, sem soltar a pegada.",
  dica: "Mantenha ombros para trás e abdômen contraído durante o exercício.",
  erro: "Deixar os ombros caírem para frente com o cansaço."
}];
const PADRAO_GENERICO = {
  execucao: "Execute o movimento com amplitude controlada, priorizando técnica antes de carga, e evite compensações com outras partes do corpo.",
  dica: "Controle tanto a fase de subida quanto a de descida do movimento.",
  erro: "Aumentar a carga antes de dominar a execução correta."
};
function gerarDescricaoExercicio(nome, grupo) {
  const padrao = PADROES_EXECUCAO.find(p => p.testar(nome)) || PADRAO_GENERICO;
  return {
    ...padrao,
    grupo
  };
}
function linkVideoExercicio(nome) {
  const query = encodeURIComponent(`${nome} execução técnica`);
  return `https://www.youtube.com/results?search_query=${query}`;
}

/* redimensiona e comprime a foto de perfil no navegador antes de salvar,
   pra manter o arquivo leve (poucos KB) no armazenamento local */
function comprimirImagem(file, maxLado = 220, qualidade = 0.72) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(new Error("Falha ao ler imagem"));
    leitor.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error("Falha ao carregar imagem"));
      img.onload = () => {
        const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * escala));
        canvas.height = Math.max(1, Math.round(img.height * escala));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", qualidade));
      };
      img.src = e.target.result;
    };
    leitor.readAsDataURL(file);
  });
}
function uid() {
  return Math.random().toString(36).slice(2, 9);
}
function formatarTempo(segundosTotais) {
  const s = Math.max(0, Math.floor(segundosTotais || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}

/* ---------- Aviso sonoro + vibração ao terminar o descanso ---------- */
function avisarFimDescanso() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const tocarBeep = (inicio, duracao, freq) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + inicio);
        gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + inicio + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + inicio + duracao);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + inicio);
        osc.stop(ctx.currentTime + inicio + duracao + 0.05);
      };
      tocarBeep(0, 0.18, 880);
      tocarBeep(0.25, 0.18, 880);
      tocarBeep(0.5, 0.28, 1046.5);
      setTimeout(() => {
        try {
          ctx.close();
        } catch (e) {}
      }, 1200);
    }
  } catch (e) {}
  try {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 300]);
  } catch (e) {}
}

/* ---------- Bipe curto de contagem regressiva (últimos 5s do descanso) ---------- */
function tocarTickDescanso() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.28, ctx.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
      setTimeout(() => {
        try {
          ctx.close();
        } catch (e) {}
      }, 300);
    }
  } catch (e) {}
  try {
    if (navigator.vibrate) navigator.vibrate(40);
  } catch (e) {}
}

/* ---------- Logo (embutida em base64, sem fundo branco) ---------- */
const LOGO_SRC = "data:image/png;base64,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";

/* ---------- Configurações: contexto global (tema + unidade de peso) ---------- */
const CONFIG_PADRAO = {
  tema: "dark",
  unidadePeso: "kg"
};
const ConfigContext = React.createContext({
  ...CONFIG_PADRAO,
  setTema: () => {},
  setUnidadePeso: () => {}
});
function useConfig() {
  return React.useContext(ConfigContext);
}

/* ---------- conversão de unidade de peso (dado sempre fica salvo em kg) ---------- */
const LB_POR_KG = 2.2046226218;
function kgParaUnidade(kg, unidade) {
  if (kg === "" || kg === null || kg === undefined || isNaN(kg)) return "";
  const n = Number(kg);
  const convertido = unidade === "lb" ? n * LB_POR_KG : n;
  const arredondado = Math.round(convertido * 100) / 100;
  return arredondado;
}
function unidadeParaKg(valor, unidade) {
  if (valor === "" || valor === null || valor === undefined || isNaN(valor)) return "";
  const n = Number(valor);
  const kg = unidade === "lb" ? n / LB_POR_KG : n;
  return Math.round(kg * 100) / 100;
}
function rotuloPeso(unidade) {
  return unidade === "lb" ? "lb" : "kg";
}
/* formata um peso em kg para exibição na unidade escolhida, com N casas decimais */
function exibirPeso(kg, unidade, casas = 1) {
  if (kg === "" || kg === null || kg === undefined || isNaN(kg)) return "—";
  const convertido = unidade === "lb" ? Number(kg) * LB_POR_KG : Number(kg);
  return convertido.toFixed(casas);
}

/* campo de peso que converte automaticamente entre kg/lb, mas sempre guarda o valor em kg */
function CampoPeso({
  label,
  valorKg,
  onChangeKg,
  placeholder,
  disabled,
  className
}) {
  const {
    unidadePeso
  } = useConfig();
  const exibicao = valorKg === "" || valorKg === null || valorKg === undefined ? "" : kgParaUnidade(valorKg, unidadePeso);
  return /*#__PURE__*/React.createElement(Field, {
    label: `${label} (${rotuloPeso(unidadePeso)})`
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    step: unidadePeso === "lb" ? "0.5" : "0.1",
    value: exibicao,
    onChange: e => {
      const v = e.target.value;
      onChangeKg(v === "" ? "" : String(unidadeParaKg(v, unidadePeso)));
    },
    placeholder: placeholder,
    disabled: disabled,
    className: className
  }));
}

/* ---------- Backup / restauração / reset de dados (localStorage) ---------- */
function listarChavesApp() {
  const chaves = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith(PREFIX)) chaves.push(k);
  }
  return chaves;
}
function exportarBackup() {
  const dados = {};
  listarChavesApp().forEach(k => {
    try {
      dados[k.slice(PREFIX.length)] = JSON.parse(window.localStorage.getItem(k));
    } catch (e) {}
  });
  const payload = {
    app: "smart-personal",
    geradoEm: new Date().toISOString(),
    dados
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const dataStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `smart-personal-backup-${dataStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function restaurarBackup(arquivoTexto) {
  const payload = JSON.parse(arquivoTexto);
  const dados = payload && payload.dados ? payload.dados : payload;
  if (!dados || typeof dados !== "object") throw new Error("Arquivo de backup inválido");
  Object.keys(dados).forEach(chave => {
    window.localStorage.setItem(PREFIX + chave, JSON.stringify(dados[chave]));
  });
}
function zerarTodosOsDados() {
  listarChavesApp().forEach(k => window.localStorage.removeItem(k));
}

/* ---------- Loading Screen ---------- */
const DURATION_MS = 5000;
function LoadingScreen({
  onDone
}) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const start = performance.now();
    let frame;
    const tick = now => {
      const elapsed = now - start;
      const pct = Math.min(elapsed / DURATION_MS * 100, 100);
      setProgress(pct);
      if (elapsed < DURATION_MS) frame = requestAnimationFrame(tick);else onDone();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col items-center gap-8"
  }, /*#__PURE__*/React.createElement("div", {
    className: "relative flex h-48 w-48 items-center justify-center rounded-full pulse-glow"
  }, /*#__PURE__*/React.createElement("img", {
    src: LOGO_SRC,
    alt: "Smart Coliseu",
    className: "h-full w-full rounded-full object-contain drop-shadow-[0_0_18px_rgba(214,0,0,0.35)]"
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col items-center gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-display text-xl font-semibold tracking-tight text-text"
  }, "Smart Coliseu"), /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "by Smart Link")), /*#__PURE__*/React.createElement("div", {
    className: "h-1 w-56 overflow-hidden rounded-full bg-surface2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-full rounded-full bg-red",
    style: {
      width: progress + "%",
      transition: "width 75ms linear"
    }
  }))));
}

/* ---------- small UI ---------- */
/* anima um valor numérico contando do valor anterior até o novo (de 0 na
   primeira renderização), preservando as casas decimais do valor de destino.
   valores não numéricos (ex: "—") passam direto, sem animação. */
function useCountUp(value, duration = 700) {
  const anteriorRef = useRef(0);
  const frameRef = useRef(null);
  const [display, setDisplay] = useState(() => {
    const casas = (String(value).split(".")[1] || "").length;
    return isNaN(parseFloat(String(value).replace(",", "."))) ? value : casas > 0 ? 0 .toFixed(casas) : "0";
  });
  useEffect(() => {
    const numAtual = parseFloat(String(value).replace(",", "."));
    if (isNaN(numAtual)) {
      setDisplay(value);
      return;
    }
    if (numAtual === anteriorRef.current) {
      setDisplay(value);
      return;
    }
    const casasDecimais = (String(value).split(".")[1] || "").length;
    const de = anteriorRef.current;
    const para = numAtual;
    const inicio = performance.now();
    const passo = agora => {
      const t = Math.min(1, (agora - inicio) / duration);
      const facilitado = 1 - Math.pow(1 - t, 3); // ease-out cúbico
      const atual = de + (para - de) * facilitado;
      setDisplay(casasDecimais > 0 ? atual.toFixed(casasDecimais) : String(Math.round(atual)));
      if (t < 1) frameRef.current = requestAnimationFrame(passo);else anteriorRef.current = para;
    };
    frameRef.current = requestAnimationFrame(passo);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [value]);
  return display;
}

/* ---------- Sistema de ícones (SVG, estilo linha, peso único) ----------
   Substitui os emojis de navegação/StatCards por um set consistente,
   que não muda de aparência entre Android/iOS/desktop e herda a cor
   do texto via currentColor. Emoji continua reservado pra conquistas,
   celebração e streak (onde o efeito "divertido" já funciona bem). */
const ICON_PATHS = {
  perfil: "M20 21a8 8 0 1 0-16 0 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  dashboard: "M3 11 12 4l9 7 M5 10v10h14V10",
  planos: "M6.5 6.5 17.5 17.5 M17.5 6.5 6.5 17.5 M4 8V4h4 M20 16v4h-4 M4 16v4h4 M20 8V4h-4",
  personalizado: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  estatisticas: "M4 20V10 M11 20V4 M18 20v-7",
  biblioteca: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z",
  conquistas: "M8 21h8 M12 17v4 M7 4h10v4a5 5 0 0 1-10 0Z M7 5H4v2a3 3 0 0 0 3 3 M17 5h3v2a3 3 0 0 1-3 3",
  configuracoes: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z",
  carga: "M6 3v4M14 3v4M4 7h12l-1 14H5L4 7Z M8 11v6M12 11v6",
  fogo: "M12 2c1.5 3-2 4.5-1 8 .5 2 2.5 2.5 3.5 1 1.5 3-1 6-4.5 6-4 0-6.5-3-6-6.5C4.3 8 6 6 6 6c.2 2 1 2.5 1.8 2 .8-.5.7-2-.3-3.5C6.5 2.5 9 1 12 2Z",
  troféu: "M8 21h8 M12 17v4 M7 4h10v4a5 5 0 0 1-10 0Z M7 5H4v2a3 3 0 0 0 3 3 M17 5h3v2a3 3 0 0 1-3 3",
  fechar: "M18 6 6 18 M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  mais: "M12 5v14 M5 12h14",
  editar: "M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z",
  lixeira: "M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  seta: "M9 18l6-6-6-6",
  raio: "M13 2 3 14h8l-1 8 10-12h-8l1-8Z",
  balanca: "M12 3v18 M7 21h10 M5 7l7-4 7 4 M2 12l3-5 3 5a3 3 0 0 1-6 0Z M16 12l3-5 3 5a3 3 0 0 1-6 0Z",
  alvo: "M12 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  altura: "M12 3v18 M8 7l4-4 4 4 M8 17l4 4 4-4",
  calendario: "M8 2v4 M16 2v4 M3 10h18 M4 4h16v16H4Z",
  bandeira: "M4 22V4 M4 4h16l-3 4 3 4H4",
  repetir: "M17 2l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 22l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3",
  halter: "M6 7v10 M18 7v10 M2 10v4 M22 10v4 M6 12h12",
  clipboard: "M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1Z M5 5h14v16H5Z M8 4v2h8V4",
  dedo: "M8 13V4a2 2 0 1 1 4 0v7 M12 5a2 2 0 1 1 4 0v6 M16 7a2 2 0 1 1 4 0v6 M8 12l-2 1a3 3 0 0 0 0 5l3 3h9a3 3 0 0 0 3-3v-5a2 2 0 0 0-2-2h-2"
};
function Icon({
  name,
  className,
  size = 18,
  strokeWidth = 2
}) {
  const d = ICON_PATHS[name];
  if (!d) return null;
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className: className,
    "aria-hidden": "true"
  }, d.split(" M").map((seg, i) => /*#__PURE__*/React.createElement("path", {
    key: i,
    d: i === 0 ? seg : "M" + seg
  })));
}
const ACCENT_ICONE = {
  red: "text-red",
  gold: "text-gold",
  green: "text-green-400"
};
function StatCard({
  label,
  value,
  unit,
  hint,
  icon,
  accent
}) {
  const valorAnimado = useCountUp(value);
  return /*#__PURE__*/React.createElement("div", {
    className: "card fade-up p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-start justify-between pl-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "flex items-baseline gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-display tabular text-2xl font-semibold text-text"
  }, valorAnimado), unit && /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-medium text-textMuted"
  }, unit)), hint && /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textFaint"
  }, hint)), /*#__PURE__*/React.createElement("div", {
    className: "rounded-lg border border-border bg-surface2 p-2 " + (ACCENT_ICONE[accent] || ACCENT_ICONE.red)
  }, /*#__PURE__*/React.createElement(Icon, {
    name: icon,
    size: 18
  }))));
}
function Field({
  label,
  children
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: "flex flex-col gap-1.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-medium text-textMuted"
  }, label), children);
}
/* estado vazio padrão do app: ícone grande num círculo com borda tracejada
   (estética "pista de corrida"), título e descrição opcionais, mais uma ação.
   use compacto=true pra um card mais discreto dentro de um fluxo já em uso. */
function EstadoVazio({
  icon,
  titulo,
  descricao,
  acao,
  compacto
}) {
  if (compacto) {
    return /*#__PURE__*/React.createElement("div", {
      className: "card fade-up flex items-center gap-3 p-4 pl-5"
    }, /*#__PURE__*/React.createElement("span", {
      className: "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface2 text-lg opacity-70"
    }, icon), /*#__PURE__*/React.createElement("span", {
      className: "text-sm text-textMuted"
    }, titulo));
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex flex-col items-center gap-3 p-8 text-center"
  }, /*#__PURE__*/React.createElement("span", {
    className: "relative flex h-20 w-20 items-center justify-center rounded-full border-2 border-dashed border-red/30 bg-surface2 text-4xl"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pointer-events-none absolute -inset-3 rounded-full opacity-70",
    style: {
      background: "radial-gradient(circle, rgba(214,0,0,0.22) 0%, rgba(214,0,0,0) 72%)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "relative"
  }, icon)), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-display text-base font-semibold text-text"
  }, titulo), descricao && /*#__PURE__*/React.createElement("span", {
    className: "max-w-xs text-sm text-textMuted"
  }, descricao)), acao);
}
function EmConstrucao({
  titulo,
  descricao,
  fase
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-6 fade-up"
  }, /*#__PURE__*/React.createElement("header", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, titulo), /*#__PURE__*/React.createElement("h1", {
    className: "font-display text-2xl font-semibold"
  }, titulo), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, descricao)), /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex flex-col items-start gap-2 p-6"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Chegando na ", fase), /*#__PURE__*/React.createElement("p", {
    className: "pl-2 text-sm text-textMuted"
  }, "Essa tela ser\xE1 constru\xEDda na pr\xF3xima etapa de entrega.")));
}

/* ---------- Configurações ---------- */
function OpcaoSegmentada({
  opcoes,
  valor,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "inline-flex rounded-lg border border-border bg-surface2 p-1"
  }, opcoes.map(op => /*#__PURE__*/React.createElement("button", {
    key: op.valor,
    type: "button",
    onClick: () => onChange(op.valor),
    className: "flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors " + (valor === op.valor ? "bg-red text-white" : "text-textMuted hover:text-text")
  }, op.icone && /*#__PURE__*/React.createElement("span", null, op.icone), op.label)));
}
function LinhaConfig({
  titulo,
  descricao,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-3 pl-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-0.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-sm font-medium text-text"
  }, titulo), descricao && /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textMuted"
  }, descricao)), children);
}

/* dias desde o último backup exportado — usado pra decidir quando
   mostrar o aviso de "faz tempo que você não exporta" */
function diasDesde(timestamp) {
  if (!timestamp) return null;
  return Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000));
}
function Configuracoes() {
  const {
    tema,
    unidadePeso,
    setTema,
    setUnidadePeso
  } = useConfig();
  const fileInputRef = useRef(null);
  const [statusBackup, setStatusBackup] = useState(null); // { tipo: "ok" | "erro", msg }
  const [confirmandoReset, setConfirmandoReset] = useState(false);
  const [resetado, setResetado] = useState(false);
  const [ultimoBackup, setUltimoBackup] = useLocalStorage("backup-ultimo-export", null);
  const [lembrete, setLembrete] = useLocalStorage("lembrete-treino", LEMBRETE_PADRAO);
  const [permissaoNotif, setPermissaoNotif] = useState(typeof Notification !== "undefined" ? Notification.permission : "unsupported");
  const alternarLembrete = async () => {
    if (typeof Notification === "undefined") return;
    if (!lembrete.ativo) {
      const permissao = await Notification.requestPermission();
      setPermissaoNotif(permissao);
      if (permissao !== "granted") return;
    }
    setLembrete(l => ({
      ...l,
      ativo: !l.ativo
    }));
  };
  const chavesSalvas = useMemo(() => listarChavesApp().length, [statusBackup, resetado]);
  const diasSemBackup = diasDesde(ultimoBackup);
  const onExportar = () => {
    try {
      exportarBackup();
      setUltimoBackup(Date.now());
      setStatusBackup({
        tipo: "ok",
        msg: "Backup exportado! Verifique os downloads do navegador."
      });
    } catch (e) {
      setStatusBackup({
        tipo: "erro",
        msg: "Não foi possível gerar o backup."
      });
    }
  };
  const onEscolherArquivo = () => fileInputRef.current && fileInputRef.current.click();
  const onArquivoSelecionado = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const leitor = new FileReader();
    leitor.onload = ev => {
      try {
        restaurarBackup(ev.target.result);
        setStatusBackup({
          tipo: "ok",
          msg: "Backup restaurado! Recarregando o app..."
        });
        setTimeout(() => window.location.reload(), 1200);
      } catch (err) {
        setStatusBackup({
          tipo: "erro",
          msg: "Arquivo inválido. Selecione um backup exportado pelo próprio app."
        });
      }
    };
    leitor.onerror = () => setStatusBackup({
      tipo: "erro",
      msg: "Falha ao ler o arquivo."
    });
    leitor.readAsText(file);
  };
  const onConfirmarReset = () => {
    zerarTodosOsDados();
    setConfirmandoReset(false);
    setResetado(true);
    setTimeout(() => window.location.reload(), 1200);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-6 fade-up"
  }, /*#__PURE__*/React.createElement("header", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Configura\xE7\xF5es"), /*#__PURE__*/React.createElement("h1", {
    className: "font-display text-2xl font-semibold"
  }, "Configura\xE7\xF5es"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, "Prefer\xEAncias do aplicativo e gerenciamento dos dados salvos.")), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Apar\xEAncia"), /*#__PURE__*/React.createElement(LinhaConfig, {
    titulo: "Tema",
    descricao: "Escolha entre fundo escuro ou fundo claro."
  }, /*#__PURE__*/React.createElement(OpcaoSegmentada, {
    valor: tema,
    onChange: setTema,
    opcoes: [{
      valor: "dark",
      label: "Escuro",
      icone: "🌙"
    }, {
      valor: "light",
      label: "Claro",
      icone: "☀"
    }]
  }))), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Unidades"), /*#__PURE__*/React.createElement(LinhaConfig, {
    titulo: "Unidade de peso",
    descricao: "Usada em carga, peso corporal e estat\xEDsticas."
  }, /*#__PURE__*/React.createElement(OpcaoSegmentada, {
    valor: unidadePeso,
    onChange: setUnidadePeso,
    opcoes: [{
      valor: "kg",
      label: "kg"
    }, {
      valor: "lb",
      label: "lb"
    }]
  }))), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Lembrete de treino"), /*#__PURE__*/React.createElement(LinhaConfig, {
    titulo: "Avisar nos dias de treino",
    descricao: permissaoNotif === "denied" ? "Notificações bloqueadas pelo navegador. Libere nas permissões do site pra ativar." : "Notificação do navegador no horário escolhido, se ainda não houver treino registrado no dia. Só funciona com o app aberto (sem servidor de notificação por trás)."
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: alternarLembrete,
    disabled: permissaoNotif === "denied",
    className: "relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:opacity-40 " + (lembrete.ativo ? "border-red bg-red/80" : "border-border bg-surface2")
  }, /*#__PURE__*/React.createElement("span", {
    className: "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all " + (lembrete.ativo ? "left-[1.375rem]" : "left-0.5")
  }))), lembrete.ativo && /*#__PURE__*/React.createElement(LinhaConfig, {
    titulo: "Hor\xE1rio do lembrete",
    descricao: "Verificado a cada minuto enquanto o app estiver aberto."
  }, /*#__PURE__*/React.createElement("input", {
    type: "time",
    value: lembrete.horario,
    onChange: e => setLembrete(l => ({
      ...l,
      horario: e.target.value
    })),
    className: "rounded-lg border border-border bg-surface2 px-3 py-2 text-sm text-text outline-none focus:border-red/50"
  }))), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Backup"), /*#__PURE__*/React.createElement("div", {
    className: "flex items-start gap-3 rounded-lg border border-border bg-surface2 p-3 pl-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, diasSemBackup == null || diasSemBackup > 14 ? "⚠" : "✓"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-0.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-sm font-medium text-text"
  }, ultimoBackup == null ? "Você ainda não exportou nenhum backup" : `Último backup: ${diasSemBackup === 0 ? "hoje" : diasSemBackup === 1 ? "há 1 dia" : `há ${diasSemBackup} dias`}`), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textMuted"
  }, "Seus dados sobem automaticamente pra sua conta e s\xE3o copiados todo dia no servidor. O backup manual serve pra ter uma c\xF3pia no seu pr\xF3prio computador."))), /*#__PURE__*/React.createElement(LinhaConfig, {
    titulo: "Exportar dados",
    descricao: "Baixa um arquivo .json com perfil, treinos, planos e hist\xF3rico."
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onExportar,
    className: "rounded-lg border border-border px-4 py-2 text-sm font-medium text-text transition-colors hover:border-red hover:text-red"
  }, "\u2B07 Exportar backup")), /*#__PURE__*/React.createElement("div", {
    className: "h-px bg-borderSoft"
  }), /*#__PURE__*/React.createElement(LinhaConfig, {
    titulo: "Restaurar backup",
    descricao: "Importa um arquivo .json exportado anteriormente e substitui os dados atuais."
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onEscolherArquivo,
    className: "rounded-lg border border-border px-4 py-2 text-sm font-medium text-text transition-colors hover:border-red hover:text-red"
  }, "\u2B06 Escolher arquivo"), /*#__PURE__*/React.createElement("input", {
    ref: fileInputRef,
    type: "file",
    accept: "application/json,.json",
    className: "hidden",
    onChange: onArquivoSelecionado
  })), statusBackup && /*#__PURE__*/React.createElement("p", {
    className: "pl-2 text-xs font-medium fade-up " + (statusBackup.tipo === "ok" ? "text-green-400" : "text-red")
  }, statusBackup.tipo === "ok" ? "✓ " : "⚠ ", statusBackup.msg)), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Conta"), /*#__PURE__*/React.createElement(ResumoDaConta, null)), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Dados salvos"), /*#__PURE__*/React.createElement(LinhaConfig, {
    titulo: "Zerar todos os dados",
    descricao: `${chavesSalvas} item(ns) salvos neste dispositivo. Essa ação apaga perfil, treinos, planos e histórico.`
  }, !confirmandoReset ? /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmandoReset(true),
    disabled: resetado,
    className: "rounded-lg border border-red/60 px-4 py-2 text-sm font-medium text-red transition-colors hover:bg-red/10 disabled:cursor-not-allowed disabled:opacity-40"
  }, "\uD83D\uDDD1 Zerar dados") : /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 fade-up"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onConfirmarReset,
    className: "rounded-lg bg-red px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
  }, "Confirmar exclus\xE3o"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmandoReset(false),
    className: "rounded-lg border border-border px-4 py-2 text-sm text-textMuted hover:text-text"
  }, "cancelar"))), confirmandoReset && /*#__PURE__*/React.createElement("p", {
    className: "pl-2 text-xs font-medium text-red fade-up"
  }, "\u26A0 Essa a\xE7\xE3o n\xE3o pode ser desfeita. Considere exportar um backup antes."), resetado && /*#__PURE__*/React.createElement("p", {
    className: "pl-2 text-xs font-medium text-green-400 fade-up"
  }, "\u2713 Dados apagados. Recarregando o app...")));
}

/* ---------- Treino: form de campos do exercício ---------- */
function CamposExercicio({
  valores,
  onChange
}) {
  const set = campo => e => onChange({
    ...valores,
    [campo]: e.target.value
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3 sm:grid-cols-4"
  }, /*#__PURE__*/React.createElement(CampoPeso, {
    label: "Carga",
    valorKg: valores.carga,
    onChangeKg: v => onChange({
      ...valores,
      carga: v
    }),
    placeholder: "0"
  }), /*#__PURE__*/React.createElement(Field, {
    label: "S\xE9ries"
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    value: valores.series,
    onChange: set("series"),
    placeholder: "0"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Repeti\xE7\xF5es"
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    value: valores.repeticoes,
    onChange: set("repeticoes"),
    placeholder: "0"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Descanso (s)"
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    value: valores.descanso,
    onChange: set("descanso"),
    placeholder: "60"
  })), /*#__PURE__*/React.createElement("div", {
    className: "col-span-2 sm:col-span-4"
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Observa\xE7\xF5es"
  }, /*#__PURE__*/React.createElement("textarea", {
    rows: "2",
    value: valores.obs,
    onChange: set("obs"),
    placeholder: "Ex: cad\xEAncia controlada, pegada aberta...",
    style: {
      resize: "none"
    }
  }))));
}
function CardExercicio({
  ex,
  pesoKg,
  onRemover,
  onSalvarEdicao,
  seriesFeitas,
  timer,
  onIniciarSerie,
  onPararSerie,
  onResetarSerie
}) {
  const {
    unidadePeso
  } = useConfig();
  const [editando, setEditando] = useState(false);
  const [campos, setCampos] = useState({
    carga: ex.carga,
    series: ex.series,
    repeticoes: ex.repeticoes,
    descanso: ex.descanso,
    obs: ex.obs
  });
  const kcal = estimarCaloriasExercicio({
    pesoKg,
    grupoMuscular: ex.grupo,
    cargaKg: parseFloat(ex.carga) || 0,
    series: parseFloat(ex.series) || 0,
    repeticoes: parseFloat(ex.repeticoes) || 0,
    descansoSegundos: parseFloat(ex.descanso) || 60
  });
  const iniciarEdicao = () => {
    setCampos({
      carga: ex.carga,
      series: ex.series,
      repeticoes: ex.repeticoes,
      descanso: ex.descanso,
      obs: ex.obs
    });
    setEditando(true);
  };
  const salvar = () => {
    onSalvarEdicao(campos);
    setEditando(false);
  };
  if (editando) {
    return /*#__PURE__*/React.createElement("div", {
      className: "fade-up flex flex-col gap-3 rounded-lg border border-red bg-surface2 p-3"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-between gap-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex flex-col"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-sm font-medium text-text"
    }, ex.nome), /*#__PURE__*/React.createElement("span", {
      className: "text-xs text-textFaint"
    }, ex.grupo))), /*#__PURE__*/React.createElement(CamposExercicio, {
      valores: campos,
      onChange: setCampos
    }), /*#__PURE__*/React.createElement("div", {
      className: "flex gap-2"
    }, /*#__PURE__*/React.createElement("button", {
      onClick: salvar,
      className: "rounded-md bg-red px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
    }, "\u2713 Salvar"), /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditando(false),
      className: "rounded-md border border-border px-3 py-1.5 text-xs text-textMuted hover:text-text"
    }, "cancelar")));
  }
  const totalSeries = parseInt(ex.series, 10) || 0;
  const feitas = seriesFeitas || [];
  const qtdFeitas = feitas.filter(Boolean).length;
  const concluido = totalSeries > 0 && qtdFeitas >= totalSeries;
  const mostrarExecucao = !!onIniciarSerie && totalSeries > 0;
  return /*#__PURE__*/React.createElement("div", {
    className: "fade-up flex flex-col gap-2 rounded-lg border p-3 transition-colors " + (mostrarExecucao && concluido ? "border-green-600/50 bg-green-950/20" : "border-border bg-surface2")
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-start justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col"
  }, /*#__PURE__*/React.createElement("span", {
    className: "flex items-center gap-2 text-sm font-medium text-text"
  }, ex.nome, mostrarExecucao && concluido && /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-semibold text-green-500"
  }, "\u2713 feito")), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textFaint"
  }, ex.grupo)), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, mostrarExecucao && totalSeries > 0 && /*#__PURE__*/React.createElement("span", {
    className: "tabular text-xs font-medium " + (concluido ? "text-green-500" : "text-textFaint")
  }, qtdFeitas, "/", totalSeries, " s\xE9ries"), /*#__PURE__*/React.createElement("button", {
    onClick: iniciarEdicao,
    className: "rounded-md border border-border px-2 py-1 text-xs text-textMuted hover:border-red hover:text-red"
  }, "editar"), /*#__PURE__*/React.createElement("button", {
    onClick: onRemover,
    className: "rounded-md border border-border px-2 py-1 text-xs text-textMuted hover:border-red hover:text-red"
  }, "remover"))), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-x-4 gap-y-1 text-xs text-textMuted"
  }, /*#__PURE__*/React.createElement("span", null, ex.carga ? exibirPeso(ex.carga, unidadePeso) : 0, " ", rotuloPeso(unidadePeso)), /*#__PURE__*/React.createElement("span", null, ex.series || 0, " s\xE9ries"), /*#__PURE__*/React.createElement("span", null, ex.repeticoes || 0, " reps"), /*#__PURE__*/React.createElement("span", null, ex.descanso || 60, "s descanso"), /*#__PURE__*/React.createElement("span", {
    className: "text-red"
  }, "~", kcal, " kcal")), ex.obs && /*#__PURE__*/React.createElement("span", {
    className: "text-xs italic text-textFaint"
  }, ex.obs), mostrarExecucao && /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1.5 pt-1"
  }, Array.from({
    length: totalSeries
  }).map((_, i) => {
    const feita = !!feitas[i];
    const rodando = timer && timer.exId === ex.id && timer.serieIndex === i;
    const outroAtivo = !!timer && !rodando;
    let estado = "pendente";
    if (rodando && timer.fase === "treino") estado = "treino";else if (rodando && timer.fase === "descanso") estado = "descanso";else if (feita) estado = "feita";
    const podeResetar = estado === "feita";
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "flex items-center justify-between gap-2 rounded-md border px-3 py-2 transition-colors " + (estado === "treino" ? "border-red/60 bg-red/5" : estado === "descanso" ? "border-border bg-bg/40" : estado === "feita" ? "border-green-900/40 bg-bg/20" : "border-borderSoft bg-bg/40")
    }, /*#__PURE__*/React.createElement("span", {
      className: "shrink-0 text-xs text-textMuted"
    }, "S\xE9rie ", i + 1), /*#__PURE__*/React.createElement("div", {
      className: "flex shrink-0 items-center gap-2"
    }, estado === "feita" && /*#__PURE__*/React.createElement("span", {
      className: "text-xs font-medium text-green-500"
    }, "\u2713 feita"), estado === "treino" && /*#__PURE__*/React.createElement("span", {
      className: "tabular text-xs font-semibold text-red animate-pulse"
    }, formatarTempo(timer.segundos)), estado === "descanso" && /*#__PURE__*/React.createElement("span", {
      className: "tabular text-xs font-semibold text-textMuted"
    }, formatarTempo(timer.segundos)), estado === "pendente" && /*#__PURE__*/React.createElement("button", {
      onClick: () => onIniciarSerie(i),
      disabled: outroAtivo,
      className: "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-red text-red transition-colors hover:bg-red hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-red",
      "aria-label": "Iniciar s\xE9rie"
    }, "\u25B6"), /*#__PURE__*/React.createElement("button", {
      onClick: () => onResetarSerie(i),
      disabled: !podeResetar,
      className: "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-textFaint transition-colors hover:border-red hover:text-red disabled:opacity-20 disabled:hover:border-border disabled:hover:text-textFaint",
      "aria-label": "Resetar s\xE9rie",
      title: "Resetar s\xE9rie"
    }, "\u21BA")));
  })));
}
const CAMPOS_VAZIOS = {
  carga: "",
  series: "",
  repeticoes: "",
  descanso: "60",
  obs: ""
};

/* ---------- Planos de Treino ---------- */
function CardExercicioView({
  ex,
  pesoKg,
  seriesFeitas,
  timer,
  onIniciarSerie,
  onPararSerie,
  onPularDescanso,
  onResetarSerie
}) {
  const {
    unidadePeso
  } = useConfig();
  const kcal = estimarCaloriasExercicio({
    pesoKg,
    grupoMuscular: ex.grupo,
    cargaKg: parseFloat(ex.carga) || 0,
    series: parseFloat(ex.series) || 0,
    repeticoes: parseFloat(ex.repeticoes) || 0,
    descansoSegundos: parseFloat(ex.descanso) || 60
  });
  const totalSeries = parseInt(ex.series, 10) || 0;
  const feitas = seriesFeitas || [];
  const qtdFeitas = feitas.filter(Boolean).length;
  const concluido = totalSeries > 0 && qtdFeitas >= totalSeries;

  /* card começa minimizado; a série que estiver rodando (treino/descanso)
     mantém o card aberto automaticamente pra não esconder o cronômetro */
  const [abertoManual, setAbertoManual] = useState(false);
  const timerNesteExercicio = !!(timer && timer.exId === ex.id);
  const aberto = abertoManual || timerNesteExercicio;
  return /*#__PURE__*/React.createElement("div", {
    className: "fade-up flex flex-col gap-3 rounded-lg border p-3 transition-colors " + (concluido ? "border-green-600/50 bg-green-950/20" : "border-border bg-surface2")
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setAbertoManual(a => !a),
    className: "flex items-start justify-between gap-2 text-left",
    "aria-expanded": aberto
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col"
  }, /*#__PURE__*/React.createElement("span", {
    className: "flex items-center gap-2 text-sm font-medium text-text"
  }, ex.nome, concluido && /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-semibold text-green-500"
  }, "\u2713 feito")), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textFaint"
  }, ex.grupo)), /*#__PURE__*/React.createElement("div", {
    className: "flex shrink-0 items-center gap-2"
  }, totalSeries > 0 && /*#__PURE__*/React.createElement("span", {
    className: "tabular text-xs font-medium " + (concluido ? "text-green-500" : "text-textFaint")
  }, qtdFeitas, "/", totalSeries, " s\xE9ries"), /*#__PURE__*/React.createElement("span", {
    className: "text-textFaint transition-transform duration-200 " + (aberto ? "rotate-180" : ""),
    "aria-hidden": "true"
  }, "\u25BE"))), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-x-4 gap-y-1 text-xs text-textMuted"
  }, /*#__PURE__*/React.createElement("span", null, ex.carga ? exibirPeso(ex.carga, unidadePeso) : 0, " ", rotuloPeso(unidadePeso)), /*#__PURE__*/React.createElement("span", null, ex.series || 0, " s\xE9ries"), /*#__PURE__*/React.createElement("span", null, ex.repeticoes || 0, " reps"), /*#__PURE__*/React.createElement("span", null, ex.descanso || 60, "s descanso"), /*#__PURE__*/React.createElement("span", {
    className: "text-red"
  }, "~", kcal, " kcal")), ex.obs && /*#__PURE__*/React.createElement("span", {
    className: "text-xs italic text-textFaint"
  }, ex.obs), totalSeries > 0 && aberto && /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1.5 pt-1"
  }, Array.from({
    length: totalSeries
  }).map((_, i) => {
    const feita = !!feitas[i];
    const rodando = timer && timer.exId === ex.id && timer.serieIndex === i;
    const outroAtivo = !!timer && !rodando;
    let estado = "pendente";
    if (rodando && timer.fase === "treino") estado = "treino";else if (rodando && timer.fase === "descanso") estado = "descanso";else if (feita) estado = "feita";
    const podeResetar = estado === "feita";
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "flex items-center justify-between gap-2 rounded-md border px-3 py-2 transition-colors " + (estado === "treino" ? "border-red/60 bg-red/5" : estado === "descanso" ? "border-border bg-bg/40" : estado === "feita" ? "border-green-900/40 bg-bg/20" : "border-borderSoft bg-bg/40")
    }, /*#__PURE__*/React.createElement("span", {
      className: "shrink-0 text-xs text-textMuted"
    }, "S\xE9rie ", i + 1), /*#__PURE__*/React.createElement("div", {
      className: "flex shrink-0 items-center gap-2"
    }, estado === "feita" && /*#__PURE__*/React.createElement("span", {
      className: "text-xs font-medium text-green-500"
    }, "\u2713 feita"), estado === "treino" && /*#__PURE__*/React.createElement("span", {
      className: "tabular text-xs font-semibold text-red animate-pulse"
    }, formatarTempo(timer.segundos)), estado === "descanso" && /*#__PURE__*/React.createElement("span", {
      className: "tabular text-xs font-semibold text-textMuted"
    }, formatarTempo(timer.segundos)), estado === "pendente" && /*#__PURE__*/React.createElement("button", {
      onClick: () => onIniciarSerie(i),
      disabled: outroAtivo,
      className: "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-red text-red transition-colors hover:bg-red hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-red",
      "aria-label": "Iniciar s\xE9rie"
    }, "\u25B6"), /*#__PURE__*/React.createElement("button", {
      onClick: () => onResetarSerie(i),
      disabled: !podeResetar,
      className: "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-textFaint transition-colors hover:border-red hover:text-red disabled:opacity-20 disabled:hover:border-border disabled:hover:text-textFaint",
      "aria-label": "Resetar s\xE9rie",
      title: "Resetar s\xE9rie"
    }, "\u21BA")));
  })));
}
function BlocoGrupoView({
  bloco,
  pesoKg,
  execucao,
  timer,
  onIniciarSerie,
  onPararSerie,
  onPularDescanso,
  onResetarSerie
}) {
  /* grupo muscular inteiro concluído = todos os exercícios do bloco com
     todas as séries marcadas como feitas */
  const grupoConcluido = bloco.exercicios.length > 0 && bloco.exercicios.every(ex => {
    const totalSeries = parseInt(ex.series, 10) || 0;
    const feitas = execucao[ex.id] && execucao[ex.id].seriesFeitas || [];
    return totalSeries > 0 && feitas.filter(Boolean).length >= totalSeries;
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex flex-col gap-3 p-5 transition-colors " + (grupoConcluido ? "border-green-600/50" : ""),
    style: grupoConcluido ? {
      background: "linear-gradient(155deg, rgba(6,78,59,0.35) 0%, rgba(5,46,38,0.35) 100%)",
      "--card-accent-bg": "linear-gradient(180deg, #22c55e, #14532d)"
    } : undefined
  }, /*#__PURE__*/React.createElement("span", {
    className: "flex items-center gap-2 pl-2 font-display text-base font-semibold"
  }, bloco.grupo, grupoConcluido && /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-semibold text-green-500"
  }, "\u2713 grupo conclu\xEDdo")), bloco.exercicios.length > 0 ? /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-2 pl-2"
  }, bloco.exercicios.map(ex => /*#__PURE__*/React.createElement(CardExercicioView, {
    key: ex.id,
    ex: ex,
    pesoKg: pesoKg,
    seriesFeitas: execucao[ex.id] && execucao[ex.id].seriesFeitas,
    timer: timer,
    onIniciarSerie: i => onIniciarSerie(ex.id, i),
    onPararSerie: onPararSerie,
    onPularDescanso: onPularDescanso,
    onResetarSerie: i => onResetarSerie(ex.id, i)
  }))) : /*#__PURE__*/React.createElement("span", {
    className: "pl-2 text-xs text-textFaint"
  }, "Nenhum exerc\xEDcio adicionado neste grupo."));
}
function BlocoGrupo({
  bloco,
  pesoKg,
  onAddExercicio,
  onEditarExercicio,
  onRemoverExercicio,
  onRemoverBloco
}) {
  const [exercicioSelecionado, setExercicioSelecionado] = useState("");
  const [campos, setCampos] = useState(CAMPOS_VAZIOS);
  const opcoes = EXERCICIOS_POR_GRUPO[bloco.grupo] || [];
  const adicionar = () => {
    if (!exercicioSelecionado) return;
    onAddExercicio(bloco.id, {
      id: uid(),
      nome: exercicioSelecionado,
      grupo: bloco.grupo,
      ...campos
    });
    setExercicioSelecionado("");
    setCampos(CAMPOS_VAZIOS);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between pl-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-display text-base font-semibold"
  }, bloco.grupo), /*#__PURE__*/React.createElement("button", {
    onClick: () => onRemoverBloco(bloco.id),
    className: "text-xs text-textFaint hover:text-red"
  }, "remover grupo")), bloco.exercicios.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-2 pl-2"
  }, bloco.exercicios.map(ex => /*#__PURE__*/React.createElement(CardExercicio, {
    key: ex.id,
    ex: ex,
    pesoKg: pesoKg,
    onRemover: () => onRemoverExercicio(bloco.id, ex.id),
    onSalvarEdicao: camposNovos => onEditarExercicio(bloco.id, ex.id, camposNovos)
  }))), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-3 border-t border-borderSoft pt-4 pl-2"
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Exerc\xEDcio"
  }, /*#__PURE__*/React.createElement("select", {
    value: exercicioSelecionado,
    onChange: e => setExercicioSelecionado(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Selecione um exerc\xEDcio de ", bloco.grupo), opcoes.map(op => /*#__PURE__*/React.createElement("option", {
    key: op,
    value: op
  }, op)))), /*#__PURE__*/React.createElement(CamposExercicio, {
    valores: campos,
    onChange: setCampos
  }), /*#__PURE__*/React.createElement("button", {
    onClick: adicionar,
    disabled: !exercicioSelecionado,
    className: "self-start rounded-lg bg-red px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
  }, "+ Adicionar Exerc\xEDcio")));
}
function chaveExecucaoDia(dia) {
  const hoje = new Date().toDateString();
  return "execucao-" + dia + "-" + hoje;
}

/* ---------- Cronômetro em tela cheia (janela maior, moldura circular vermelha) ---------- */
function CronometroModal({
  timer,
  exercicio,
  onParar,
  onPular
}) {
  if (!timer || !exercicio) return null;
  const isTreino = timer.fase === "treino";
  const duracao = timer.duracaoDescanso || 120;
  const fracaoRestante = isTreino ? 1 : Math.max(0, Math.min(1, timer.segundos / duracao));
  const raio = 88;
  const circunferencia = 2 * Math.PI * raio;
  const offset = circunferencia * (1 - fracaoRestante);
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 bg-black/90 px-4 backdrop-blur-sm fade-up"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col items-center gap-1 text-center"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, isTreino ? "Série em execução" : "Descanso"), /*#__PURE__*/React.createElement("span", {
    className: "font-display text-xl font-semibold text-text"
  }, exercicio.nome), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textMuted"
  }, "S\xE9rie ", timer.serieIndex + 1, " de ", exercicio.series)), /*#__PURE__*/React.createElement("div", {
    className: "relative flex h-72 w-72 items-center justify-center sm:h-80 sm:w-80"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 200 200",
    className: "absolute inset-0 h-full w-full -rotate-90"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "100",
    cy: "100",
    r: raio,
    fill: "none",
    stroke: "#1a1a1a",
    strokeWidth: "8"
  }), !isTreino && /*#__PURE__*/React.createElement("circle", {
    cx: "100",
    cy: "100",
    r: raio,
    fill: "none",
    stroke: "#d60000",
    strokeWidth: "8",
    strokeLinecap: "round",
    strokeDasharray: circunferencia,
    strokeDashoffset: offset,
    style: {
      transition: "stroke-dashoffset 1s linear"
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "relative flex h-56 w-56 items-center justify-center rounded-full border-4 border-red sm:h-64 sm:w-64 " + (isTreino ? "pulse-glow" : ""),
    style: {
      background: "radial-gradient(circle at 32% 28%, #1a0303, #050505 72%)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-display tabular text-5xl font-bold text-text"
  }, formatarTempo(timer.segundos)))), isTreino ? /*#__PURE__*/React.createElement("button", {
    onClick: onParar,
    className: "flex items-center gap-2 rounded-full bg-red px-10 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
  }, "\u25A0 Parar s\xE9rie") : /*#__PURE__*/React.createElement("button", {
    onClick: onPular,
    className: "flex items-center gap-2 rounded-full border border-border px-10 py-3 text-sm font-medium text-textMuted transition-colors hover:border-red hover:text-red"
  }, "Pular descanso"));
}

/* gera um bloco pronto pra um grupo muscular, puxando os primeiros N
   exercícios já cadastrados na biblioteca do grupo, com séries/reps
   padrão (a pessoa ajusta a carga depois, no primeiro treino) */
function gerarBlocoModelo(grupo, qtdExercicios = 3) {
  const exercicios = (EXERCICIOS_POR_GRUPO[grupo] || []).slice(0, qtdExercicios).map(nome => ({
    id: uid(),
    nome,
    grupo,
    carga: "",
    series: "3",
    repeticoes: "12",
    descanso: "60",
    obs: ""
  }));
  return {
    id: uid(),
    grupo,
    exercicios
  };
}

/* planos prontos pra começar rápido: cada modelo define, por dia da
   semana, quais grupos musculares entram no treino. Os exercícios de
   cada grupo são preenchidos automaticamente a partir da biblioteca. */
const PLANOS_MODELO = [{
  id: "full-body-3x",
  titulo: "Full Body · 3x por semana",
  descricao: "Corpo inteiro em cada treino. Bom pra começar ou pra rotina mais enxuta.",
  dias: {
    Segunda: ["Peito", "Costas", "Pernas", "Ombros", "Abdômen"],
    Quarta: ["Peito", "Costas", "Pernas", "Ombros", "Abdômen"],
    Sexta: ["Peito", "Costas", "Pernas", "Ombros", "Abdômen"]
  }
}, {
  id: "upper-lower-4x",
  titulo: "Upper/Lower · 4x por semana",
  descricao: "Divide entre parte superior e inferior do corpo, 2x cada por semana.",
  dias: {
    Segunda: ["Peito", "Costas", "Ombros", "Bíceps", "Tríceps"],
    Terça: ["Pernas", "Quadríceps", "Posterior", "Glúteos", "Panturrilhas"],
    Quinta: ["Peito", "Costas", "Ombros", "Bíceps", "Tríceps"],
    Sexta: ["Pernas", "Quadríceps", "Posterior", "Glúteos", "Panturrilhas"]
  }
}, {
  id: "abc-3x",
  titulo: "ABC · 3x por semana",
  descricao: "Peito/Tríceps, Costas/Bíceps e Pernas/Ombros em dias alternados.",
  dias: {
    Segunda: ["Peito", "Tríceps"],
    Quarta: ["Costas", "Bíceps"],
    Sexta: ["Pernas", "Quadríceps", "Ombros", "Abdômen"]
  }
}, {
  id: "ppl-6x",
  titulo: "Push/Pull/Legs · 6x por semana",
  descricao: "Empurrar, puxar e pernas, repetido duas vezes na semana. Pra rotina mais avançada.",
  dias: {
    Segunda: ["Peito", "Ombros", "Tríceps"],
    Terça: ["Costas", "Bíceps", "Trapézio"],
    Quarta: ["Pernas", "Quadríceps", "Posterior", "Glúteos", "Panturrilhas"],
    Quinta: ["Peito", "Ombros", "Tríceps"],
    Sexta: ["Costas", "Bíceps", "Trapézio"],
    Sábado: ["Pernas", "Quadríceps", "Posterior", "Glúteos", "Panturrilhas"]
  }
}];

/* card de um plano modelo, com confirmação antes de aplicar quando isso
   for sobrescrever dias que já têm treino montado */
function CardPlanoModelo({
  modelo,
  temConflito,
  onAplicar
}) {
  const [confirmando, setConfirmando] = useState(false);
  const dias = Object.keys(modelo.dias);
  return /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex flex-col gap-3 p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-display text-base font-semibold text-text"
  }, modelo.titulo), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textMuted"
  }, modelo.descricao)), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-1.5"
  }, dias.map(d => /*#__PURE__*/React.createElement("span", {
    key: d,
    className: "rounded-full border border-border bg-surface2 px-2.5 py-1 text-[0.65rem] text-textFaint"
  }, d))), !confirmando ? /*#__PURE__*/React.createElement("button", {
    onClick: () => temConflito ? setConfirmando(true) : onAplicar(),
    className: "self-start rounded-lg border border-red/60 px-3 py-1.5 text-xs font-medium text-red transition-colors hover:bg-red/10"
  }, "Usar este plano") : /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-2 fade-up"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[0.7rem] text-textMuted"
  }, "Isso substitui o treino j\xE1 montado nesses dias. Confirma?"), /*#__PURE__*/React.createElement("button", {
    onClick: onAplicar,
    className: "rounded-lg bg-red px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
  }, "Confirmar"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmando(false),
    className: "rounded-lg border border-border px-3 py-1.5 text-xs text-textMuted hover:text-text"
  }, "Cancelar")));
}

/* seção com os planos prontos — some assim que a pessoa já tiver algum
   dia configurado manualmente e não precisar mais do atalho, mas fica
   sempre acessível expandindo "ver planos prontos". */
function PlanosProntos({
  diasSelecionados,
  planos,
  onAplicarModelo
}) {
  const [aberto, setAberto] = useState(diasSelecionados.length === 0);
  const aplicar = modelo => {
    const diasDoModelo = Object.keys(modelo.dias);
    const novosPlanos = {};
    diasDoModelo.forEach(dia => {
      novosPlanos[dia] = modelo.dias[dia].map(grupo => gerarBlocoModelo(grupo));
    });
    onAplicarModelo(diasDoModelo, novosPlanos);
    setAberto(false);
  };
  return /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-3 p-5"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setAberto(a => !a),
    className: "flex items-center justify-between gap-2 pl-2 text-left"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Planos prontos"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textMuted"
  }, "Comece r\xE1pido com um modelo pronto e ajuste depois.")), /*#__PURE__*/React.createElement(Icon, {
    name: "seta",
    size: 16,
    className: "shrink-0 transition-transform " + (aberto ? "rotate-90" : "")
  })), aberto && /*#__PURE__*/React.createElement("div", {
    className: "grid gap-3 sm:grid-cols-2"
  }, PLANOS_MODELO.map(modelo => {
    const temConflito = Object.keys(modelo.dias).some(d => (planos[d] || []).length > 0);
    return /*#__PURE__*/React.createElement(CardPlanoModelo, {
      key: modelo.id,
      modelo: modelo,
      temConflito: temConflito,
      onAplicar: () => aplicar(modelo)
    });
  })));
}
function PlanosTreino() {
  const {
    unidadePeso
  } = useConfig();
  const [perfil] = useLocalStorage("perfil", {});
  const [diasSelecionados, setDiasSelecionados] = useLocalStorage("dias-selecionados", []);
  const [planos, setPlanos] = useLocalStorage("planos", {});
  const [sessoes, setSessoes] = useLocalStorage("treinos-log", []);
  const [diaAtivo, setDiaAtivo] = useState(null);
  const [novoGrupo, setNovoGrupo] = useState("");
  const [modoEdicao, setModoEdicao] = useState(false);
  const [execucao, setExecucaoState] = useState({});
  const [timer, setTimer] = useState(null);
  const [toastPR, setToastPR] = useState(null); // [{ nome, carga }, ...]
  const recordesNotificadosRef = useRef(new Set());
  const pesoKg = parseFloat(perfil.peso) || 0;

  /* carrega o progresso de execução do dia sempre que o dia ativo muda */
  useEffect(() => {
    setTimer(null);
    recordesNotificadosRef.current = new Set();
    if (!diaAtivo) {
      setExecucaoState({});
      return;
    }
    try {
      const raw = window.localStorage.getItem(PREFIX + chaveExecucaoDia(diaAtivo));
      setExecucaoState(raw ? JSON.parse(raw) : {});
    } catch (e) {
      setExecucaoState({});
    }
  }, [diaAtivo]);
  const setExecucao = updater => {
    setExecucaoState(prev => {
      const novo = typeof updater === "function" ? updater(prev) : updater;
      try {
        window.localStorage.setItem(PREFIX + chaveExecucaoDia(diaAtivo), JSON.stringify(novo));
      } catch (e) {}
      return novo;
    });
  };

  /* cronômetro: conta pra cima durante a série, conta pra baixo no descanso */
  useEffect(() => {
    if (!timer) return;
    const id = setInterval(() => {
      setTimer(t => {
        if (!t) return t;
        if (t.fase === "treino") {
          return {
            ...t,
            segundos: t.segundos + 1
          };
        }
        const novoSegundos = t.segundos - 1;
        if (novoSegundos <= 0) {
          avisarFimDescanso();
          return null;
        }
        if (novoSegundos <= 5) tocarTickDescanso();
        return {
          ...t,
          segundos: novoSegundos
        };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [timer && timer.fase, timer && timer.exId, timer && timer.serieIndex]);

  /* recalcula e grava (ou remove) a sessão do dia ativo no log, de forma síncrona,
     sempre que uma série é marcada ou resetada — evita depender de um useEffect
     que podia rodar com o diaAtivo e a execucao temporariamente dessincronizados
     ao trocar rápido de dia (ex: dessincronizar o "resetar" do Dashboard) */
  const syncSessaoDoDia = execucaoAtual => {
    if (!diaAtivo) return;
    const exerciciosDoDia = (planos[diaAtivo] || []).flatMap(b => b.exercicios);
    if (exerciciosDoDia.length === 0) return;
    const sessaoId = diaAtivo + "-" + new Date().toDateString();

    /* concluidosLista é a base única de verdade da sessão: só exercícios com
       TODAS as séries marcadas entram aqui. seriesConcluidas, cargaTotal,
       calorias e maiorCarga são todos derivados dela, pra nunca ficarem
       dessincronizados entre si (ex: série de exercício não terminado não
       pode contar em "séries" se o peso dela não conta em "carga"). */
    const concluidosLista = exerciciosDoDia.filter(ex => {
      const totalSeries = parseInt(ex.series, 10) || 0;
      const feitas = execucaoAtual[ex.id] && execucaoAtual[ex.id].seriesFeitas || [];
      return totalSeries > 0 && feitas.filter(Boolean).length >= totalSeries;
    });
    const seriesConcluidas = concluidosLista.reduce((t, ex) => t + (parseInt(ex.series, 10) || 0), 0);
    setSessoes(prev => {
      const idx = prev.findIndex(s => s.id === sessaoId);

      /* só conta como "treino realizado" quando pelo menos 1 exercício foi
         concluído por completo (todas as séries dele) — marcar uma única
         série avulsa não deve aparecer como dia treinado no Dashboard */
      if (concluidosLista.length === 0) {
        if (idx === -1) return prev;
        return prev.filter(s => s.id !== sessaoId);
      }
      const cargaTotal = concluidosLista.reduce((t, ex) => t + (parseFloat(ex.carga) || 0) * (parseFloat(ex.series) || 0), 0);
      const maiorCarga = concluidosLista.reduce((m, ex) => Math.max(m, parseFloat(ex.carga) || 0), 0);
      const caloriasFeitas = concluidosLista.reduce((t, ex) => t + estimarCaloriasExercicio({
        pesoKg,
        grupoMuscular: ex.grupo,
        cargaKg: parseFloat(ex.carga) || 0,
        series: parseFloat(ex.series) || 0,
        repeticoes: parseFloat(ex.repeticoes) || 0,
        descansoSegundos: parseFloat(ex.descanso) || 60
      }), 0);
      const detalhes = concluidosLista.map(ex => ({
        nome: ex.nome,
        grupo: ex.grupo,
        carga: parseFloat(ex.carga) || 0
      }));
      const sessaoAtualizada = {
        id: sessaoId,
        data: idx !== -1 ? prev[idx].data : Date.now(),
        dia: diaAtivo,
        exercicios: concluidosLista.map(e => e.id),
        seriesConcluidas,
        cargaTotal,
        calorias: caloriasFeitas,
        maiorCarga,
        detalhes
      };

      /* PR automático: compara a carga de cada exercício concluído contra o
         maior valor já registrado pra esse mesmo exercício em outras sessões */
      const maxHistorico = {};
      prev.forEach(s => {
        if (s.id === sessaoId) return;
        (s.detalhes || []).forEach(d => {
          maxHistorico[d.nome] = Math.max(maxHistorico[d.nome] || 0, d.carga);
        });
      });
      const novosRecordes = detalhes.filter(d => {
        if (d.carga <= 0 || d.carga <= (maxHistorico[d.nome] || 0)) return false;
        if (recordesNotificadosRef.current.has(d.nome)) return false;
        return true;
      });
      if (novosRecordes.length > 0) {
        novosRecordes.forEach(d => recordesNotificadosRef.current.add(d.nome));
        setToastPR(novosRecordes);
      }
      if (idx === -1) return [...prev, sessaoAtualizada];
      const copia = [...prev];
      copia[idx] = sessaoAtualizada;
      return copia;
    });
  };
  const marcarSerieFeita = (exId, serieIndex) => {
    const atual = execucao[exId] && execucao[exId].seriesFeitas || [];
    const nova = [...atual];
    nova[serieIndex] = true;
    const novoExecucao = {
      ...execucao,
      [exId]: {
        seriesFeitas: nova
      }
    };
    setExecucao(novoExecucao);
    syncSessaoDoDia(novoExecucao);
  };
  const iniciarSerie = (exId, serieIndex) => {
    if (timer) return;
    setTimer({
      exId,
      serieIndex,
      fase: "treino",
      segundos: 0
    });
  };
  const pararSerie = () => {
    if (!timer) return;
    const {
      exId,
      serieIndex
    } = timer;
    marcarSerieFeita(exId, serieIndex);
    const ex = (planos[diaAtivo] || []).flatMap(b => b.exercicios).find(e => e.id === exId);
    const descanso = parseInt(ex && ex.descanso, 10) || 120;
    setTimer({
      exId,
      serieIndex,
      fase: "descanso",
      segundos: descanso,
      duracaoDescanso: descanso
    });
  };
  const pularDescanso = () => setTimer(null);
  const resetarSerie = (exId, serieIndex) => {
    setTimer(t => t && t.exId === exId && t.serieIndex === serieIndex ? null : t);
    const atual = execucao[exId] && execucao[exId].seriesFeitas || [];
    const nova = [...atual];
    nova[serieIndex] = false;
    const novoExecucao = {
      ...execucao,
      [exId]: {
        seriesFeitas: nova
      }
    };
    setExecucao(novoExecucao);
    syncSessaoDoDia(novoExecucao);
  };
  const diasOrdenados = [...diasSelecionados].sort((a, b) => DIAS_SEMANA.indexOf(a) - DIAS_SEMANA.indexOf(b));
  const toggleDia = dia => {
    setDiasSelecionados(prev => {
      const jaTem = prev.includes(dia);
      const novo = jaTem ? prev.filter(d => d !== dia) : [...prev, dia];
      if (!jaTem && !planos[dia]) setPlanos(p => ({
        ...p,
        [dia]: []
      }));
      if (diaAtivo === dia && jaTem) setDiaAtivo(null);
      return novo;
    });
  };
  const selecionarDia = dia => {
    setDiaAtivo(dia);
    setModoEdicao((planos[dia] || []).length === 0);
  };
  const adicionarGrupo = () => {
    if (!novoGrupo || !diaAtivo) return;
    setPlanos(p => ({
      ...p,
      [diaAtivo]: [...(p[diaAtivo] || []), {
        id: uid(),
        grupo: novoGrupo,
        exercicios: []
      }]
    }));
    setNovoGrupo("");
  };
  const addExercicio = (blocoId, exercicio) => {
    setPlanos(p => ({
      ...p,
      [diaAtivo]: p[diaAtivo].map(b => b.id === blocoId ? {
        ...b,
        exercicios: [...b.exercicios, exercicio]
      } : b)
    }));
  };
  const editarExercicio = (blocoId, exId, camposNovos) => {
    setPlanos(p => ({
      ...p,
      [diaAtivo]: p[diaAtivo].map(b => b.id === blocoId ? {
        ...b,
        exercicios: b.exercicios.map(e => e.id === exId ? {
          ...e,
          ...camposNovos
        } : e)
      } : b)
    }));
  };
  const removerExercicio = (blocoId, exId) => {
    setPlanos(p => ({
      ...p,
      [diaAtivo]: p[diaAtivo].map(b => b.id === blocoId ? {
        ...b,
        exercicios: b.exercicios.filter(e => e.id !== exId)
      } : b)
    }));
  };
  const removerBloco = blocoId => {
    setPlanos(p => ({
      ...p,
      [diaAtivo]: p[diaAtivo].filter(b => b.id !== blocoId)
    }));
  };
  const blocosDoDia = diaAtivo ? planos[diaAtivo] || [] : [];
  const caloriasDoDia = blocosDoDia.reduce((total, b) => total + b.exercicios.reduce((t, ex) => t + estimarCaloriasExercicio({
    pesoKg,
    grupoMuscular: ex.grupo,
    cargaKg: parseFloat(ex.carga) || 0,
    series: parseFloat(ex.series) || 0,
    repeticoes: parseFloat(ex.repeticoes) || 0,
    descansoSegundos: parseFloat(ex.descanso) || 60
  }), 0), 0);
  const todosExerciciosDoDia = blocosDoDia.flatMap(b => b.exercicios);
  const exerciciosConcluidos = todosExerciciosDoDia.filter(ex => {
    const totalSeries = parseInt(ex.series, 10) || 0;
    const feitas = execucao[ex.id] && execucao[ex.id].seriesFeitas || [];
    return totalSeries > 0 && feitas.filter(Boolean).length >= totalSeries;
  }).length;
  const exercicioDoTimer = timer ? todosExerciciosDoDia.find(e => e.id === timer.exId) : null;
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-6 fade-up"
  }, toastPR && /*#__PURE__*/React.createElement(CelebracaoOverlay, {
    tipo: "recorde",
    icon: "trof\xE9u",
    titulo: toastPR.length === 1 ? "Novo recorde no " + toastPR[0].nome + "!" : "Novos recordes!",
    subtitulo: toastPR.length === 1 ? "Você superou sua marca anterior nesse exercício." : "Você superou sua marca anterior em " + toastPR.length + " exercícios.",
    detalhe: toastPR.map(r => r.nome + ": " + exibirPeso(r.carga, unidadePeso) + " " + rotuloPeso(unidadePeso)).join(" · "),
    onFechar: () => setToastPR(null)
  }), /*#__PURE__*/React.createElement("header", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Planos de Treino"), /*#__PURE__*/React.createElement("h1", {
    className: "font-display text-2xl font-semibold"
  }, "Monte sua semana"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, "Selecione os dias que voc\xEA treina e monte cada treino por grupo muscular.")), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-3 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Dias da semana"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-2 pl-2"
  }, DIAS_SEMANA.map(dia => {
    const ativo = diasSelecionados.includes(dia);
    return /*#__PURE__*/React.createElement("button", {
      key: dia,
      onClick: () => toggleDia(dia),
      className: "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors " + (ativo ? "border-red bg-red/10 text-text" : "border-border text-textMuted hover:text-text")
    }, /*#__PURE__*/React.createElement("span", null, ativo ? "☑" : "☐"), dia);
  }))), /*#__PURE__*/React.createElement(PlanosProntos, {
    diasSelecionados: diasSelecionados,
    planos: planos,
    onAplicarModelo: (diasDoModelo, novosPlanos) => {
      setDiasSelecionados(prev => [...new Set([...prev, ...diasDoModelo])]);
      setPlanos(p => ({
        ...p,
        ...novosPlanos
      }));
    }
  }), diasSelecionados.length > 0 && /*#__PURE__*/React.createElement("section", {
    className: "flex flex-col gap-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, diasOrdenados.map(dia => {
    const totalExDia = (planos[dia] || []).flatMap(b => b.exercicios).length;
    const dataDoDia = dataDoDiaNaSemana(dia);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const diaJaPassou = dataDoDia < hoje;
    const sessaoDoDia = sessoes.find(s => s.dia === dia && new Date(s.data).toDateString() === dataDoDia.toDateString());
    const diaConcluido = totalExDia > 0 && !!sessaoDoDia && sessaoDoDia.exercicios.length >= totalExDia;
    const diaPerdido = !diaConcluido && diaJaPassou && totalExDia > 0;
    const corStatus = diaConcluido ? "bg-green-600/15 text-green-400 border border-green-600/50" : diaPerdido ? "bg-red/10 text-red border border-red/50" : "bg-surface2 text-textMuted border border-transparent hover:text-text";
    return /*#__PURE__*/React.createElement("button", {
      key: dia,
      onClick: () => selecionarDia(dia),
      className: "rounded-lg px-4 py-2 text-sm font-medium transition-colors " + corStatus + (diaAtivo === dia ? " outline outline-2 outline-offset-2 outline-text/70" : "")
    }, dia, (planos[dia]?.length ?? 0) > 0 && /*#__PURE__*/React.createElement("span", {
      className: "ml-1 text-xs opacity-70"
    }, "(", planos[dia].length, ")"));
  })), diaAtivo && !modoEdicao && /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-4"
  }, caloriasDoDia > 0 && /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex items-center justify-between p-4 pl-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-0.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-sm text-textMuted"
  }, "Estimativa de calorias do treino de ", diaAtivo), todosExerciciosDoDia.length > 0 && /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-medium " + (exerciciosConcluidos >= todosExerciciosDoDia.length ? "text-green-500" : "text-textFaint")
  }, exerciciosConcluidos, "/", todosExerciciosDoDia.length, " exerc\xEDcios conclu\xEDdos", exerciciosConcluidos >= todosExerciciosDoDia.length ? " ✓" : "")), /*#__PURE__*/React.createElement("span", {
    className: "font-display text-lg font-semibold text-red"
  }, "~", caloriasDoDia, " kcal")), blocosDoDia.length > 0 ? blocosDoDia.map(bloco => /*#__PURE__*/React.createElement(BlocoGrupoView, {
    key: bloco.id,
    bloco: bloco,
    pesoKg: pesoKg,
    execucao: execucao,
    timer: timer,
    onIniciarSerie: iniciarSerie,
    onPararSerie: pararSerie,
    onPularDescanso: pularDescanso,
    onResetarSerie: resetarSerie
  })) : /*#__PURE__*/React.createElement(EstadoVazio, {
    compacto: true,
    icon: "\uD83D\uDCCB",
    titulo: "Nenhum treino salvo para " + diaAtivo + " ainda."
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => setModoEdicao(true),
    className: "self-start rounded-lg border border-border px-4 py-2 text-sm font-medium text-textMuted transition-colors hover:border-red hover:text-red"
  }, "\u270E Editar treino do dia")), diaAtivo && modoEdicao && /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-4"
  }, caloriasDoDia > 0 && /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex items-center justify-between p-4 pl-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-sm text-textMuted"
  }, "Estimativa de calorias do treino de ", diaAtivo), /*#__PURE__*/React.createElement("span", {
    className: "font-display text-lg font-semibold text-red"
  }, "~", caloriasDoDia, " kcal")), blocosDoDia.map(bloco => /*#__PURE__*/React.createElement(BlocoGrupo, {
    key: bloco.id,
    bloco: bloco,
    pesoKg: pesoKg,
    onAddExercicio: addExercicio,
    onEditarExercicio: editarExercicio,
    onRemoverExercicio: removerExercicio,
    onRemoverBloco: removerBloco
  })), /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex flex-col gap-3 p-5 sm:flex-row sm:items-end sm:justify-between"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex-1"
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Adicionar grupo muscular"
  }, /*#__PURE__*/React.createElement("select", {
    value: novoGrupo,
    onChange: e => setNovoGrupo(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Selecione um grupo muscular"), GRUPOS_MUSCULARES.map(g => /*#__PURE__*/React.createElement("option", {
    key: g,
    value: g
  }, g))))), /*#__PURE__*/React.createElement("button", {
    onClick: adicionarGrupo,
    disabled: !novoGrupo,
    className: "rounded-lg bg-red px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
  }, "+ Adicionar Grupo Muscular")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setModoEdicao(false),
    className: "self-start rounded-lg bg-red px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
  }, "\u2713 Salvar Treino do Dia")), !diaAtivo && /*#__PURE__*/React.createElement(EstadoVazio, {
    compacto: true,
    icon: "\uD83D\uDC46",
    titulo: "Clique em um dia acima para ver o treino."
  })), /*#__PURE__*/React.createElement(CronometroModal, {
    timer: timer,
    exercicio: exercicioDoTimer,
    onParar: pararSerie,
    onPular: pularDescanso
  }));
}

/* ---------- Treino Personalizado ---------- */
function chaveExecucaoPersonalizado() {
  const hoje = new Date().toDateString();
  return "execucao-personalizado-" + hoje;
}
function TreinoPersonalizado() {
  const [perfil] = useLocalStorage("perfil", {});
  const [lista, setLista] = useLocalStorage("treino-personalizado", []);
  const [nome, setNome] = useState("");
  const [grupo, setGrupo] = useState("");
  const [campos, setCampos] = useState(CAMPOS_VAZIOS);
  const [execucao, setExecucaoState] = useState({});
  const [timer, setTimer] = useState(null);
  const pesoKg = parseFloat(perfil.peso) || 0;

  /* carrega o progresso de execução do dia (reseta automaticamente a cada dia) */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PREFIX + chaveExecucaoPersonalizado());
      setExecucaoState(raw ? JSON.parse(raw) : {});
    } catch (e) {
      setExecucaoState({});
    }
  }, []);
  const setExecucao = updater => {
    setExecucaoState(prev => {
      const novo = typeof updater === "function" ? updater(prev) : updater;
      try {
        window.localStorage.setItem(PREFIX + chaveExecucaoPersonalizado(), JSON.stringify(novo));
      } catch (e) {}
      return novo;
    });
  };

  /* cronômetro: conta pra cima durante a série, conta pra baixo no descanso;
     dispara aviso sonoro + vibração quando o descanso termina */
  useEffect(() => {
    if (!timer) return;
    const id = setInterval(() => {
      setTimer(t => {
        if (!t) return t;
        if (t.fase === "treino") {
          return {
            ...t,
            segundos: t.segundos + 1
          };
        }
        const novoSegundos = t.segundos - 1;
        if (novoSegundos <= 0) {
          avisarFimDescanso();
          return null;
        }
        if (novoSegundos <= 5) tocarTickDescanso();
        return {
          ...t,
          segundos: novoSegundos
        };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [timer && timer.fase, timer && timer.exId, timer && timer.serieIndex]);
  const adicionar = () => {
    if (!nome || !grupo) return;
    setLista(prev => [...prev, {
      id: uid(),
      nome,
      grupo,
      ...campos
    }]);
    setNome("");
    setGrupo("");
    setCampos(CAMPOS_VAZIOS);
  };
  const remover = id => {
    setLista(prev => prev.filter(e => e.id !== id));
    setExecucao(prev => {
      if (!prev[id]) return prev;
      const novo = {
        ...prev
      };
      delete novo[id];
      return novo;
    });
  };
  const marcarSerieFeita = (exId, serieIndex) => {
    const atual = execucao[exId] && execucao[exId].seriesFeitas || [];
    const nova = [...atual];
    nova[serieIndex] = true;
    setExecucao({
      ...execucao,
      [exId]: {
        seriesFeitas: nova
      }
    });
  };
  const iniciarSerie = (exId, serieIndex) => {
    if (timer) return;
    setTimer({
      exId,
      serieIndex,
      fase: "treino",
      segundos: 0
    });
  };
  const pararSerie = () => {
    if (!timer) return;
    const {
      exId,
      serieIndex
    } = timer;
    marcarSerieFeita(exId, serieIndex);
    const ex = lista.find(e => e.id === exId);
    const descanso = parseInt(ex && ex.descanso, 10) || 120;
    setTimer({
      exId,
      serieIndex,
      fase: "descanso",
      segundos: descanso,
      duracaoDescanso: descanso
    });
  };
  const pularDescanso = () => setTimer(null);
  const resetarSerie = (exId, serieIndex) => {
    setTimer(t => t && t.exId === exId && t.serieIndex === serieIndex ? null : t);
    const atual = execucao[exId] && execucao[exId].seriesFeitas || [];
    const nova = [...atual];
    nova[serieIndex] = false;
    setExecucao({
      ...execucao,
      [exId]: {
        seriesFeitas: nova
      }
    });
  };
  const caloriasTotais = lista.reduce((t, ex) => t + estimarCaloriasExercicio({
    pesoKg,
    grupoMuscular: ex.grupo,
    cargaKg: parseFloat(ex.carga) || 0,
    series: parseFloat(ex.series) || 0,
    repeticoes: parseFloat(ex.repeticoes) || 0,
    descansoSegundos: parseFloat(ex.descanso) || 60
  }), 0);
  const exercicioDoTimer = timer ? lista.find(e => e.id === timer.exId) : null;
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-6 fade-up"
  }, /*#__PURE__*/React.createElement("header", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Treino Personalizado"), /*#__PURE__*/React.createElement("h1", {
    className: "font-display text-2xl font-semibold"
  }, "Crie seus exerc\xEDcios"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, "Sem lista fixa: cadastre qualquer exerc\xEDcio, do seu jeito ou do personal. Toque em \u25B6 para iniciar uma s\xE9rie e cronometrar o descanso.")), lista.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-2"
  }, lista.map(ex => /*#__PURE__*/React.createElement(CardExercicio, {
    key: ex.id,
    ex: ex,
    pesoKg: pesoKg,
    onRemover: () => remover(ex.id),
    onSalvarEdicao: camposNovos => setLista(prev => prev.map(e => e.id === ex.id ? {
      ...e,
      ...camposNovos
    } : e)),
    seriesFeitas: execucao[ex.id] && execucao[ex.id].seriesFeitas,
    timer: timer,
    onIniciarSerie: i => iniciarSerie(ex.id, i),
    onPararSerie: pararSerie,
    onResetarSerie: i => resetarSerie(ex.id, i)
  })), caloriasTotais > 0 && /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex items-center justify-between p-4 pl-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-sm text-textMuted"
  }, "Estimativa de calorias total"), /*#__PURE__*/React.createElement("span", {
    className: "font-display text-lg font-semibold text-red"
  }, "~", caloriasTotais, " kcal"))), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 gap-4 pl-2 sm:grid-cols-2"
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Nome do exerc\xEDcio"
  }, /*#__PURE__*/React.createElement("input", {
    value: nome,
    onChange: e => setNome(e.target.value),
    placeholder: "Ex: Supino no TRX"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Grupo muscular"
  }, /*#__PURE__*/React.createElement("select", {
    value: grupo,
    onChange: e => setGrupo(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Selecione"), GRUPOS_MUSCULARES.map(g => /*#__PURE__*/React.createElement("option", {
    key: g,
    value: g
  }, g))))), /*#__PURE__*/React.createElement("div", {
    className: "pl-2"
  }, /*#__PURE__*/React.createElement(CamposExercicio, {
    valores: campos,
    onChange: setCampos
  })), /*#__PURE__*/React.createElement("button", {
    onClick: adicionar,
    disabled: !nome || !grupo,
    className: "self-start rounded-lg bg-red px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 ml-2"
  }, "+ Adicionar Exerc\xEDcio")), /*#__PURE__*/React.createElement(CronometroModal, {
    timer: timer,
    exercicio: exercicioDoTimer,
    onParar: pararSerie,
    onPular: pularDescanso
  }));
}

/* ---------- Perfil ---------- */
const OBJETIVOS = ["Emagrecer", "Ganhar Massa", "Hipertrofia", "Definição", "Condicionamento"];
const PERFIL_INICIAL = {
  nome: "",
  foto: "",
  idade: "",
  altura: "",
  peso: "",
  pesoObjetivo: "",
  sexo: "masculino",
  objetivo: "Hipertrofia"
};

/* faixas de IMC usadas na barra colorida do Perfil */
function IMCBar({
  imc
}) {
  const MIN = 15,
    MAX = 40;
  const pct = imc == null ? null : Math.max(0, Math.min(100, (imc - MIN) / (MAX - MIN) * 100));
  const marcas = [18.5, 25, 30, 35];
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-2 pl-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "relative h-3 w-full overflow-hidden rounded-full",
    style: {
      background: "linear-gradient(90deg, #3b82f6 0%, #3b82f6 14%, #22c55e 14%, #22c55e 40%, #eab308 40%, #eab308 60%, #f97316 60%, #f97316 80%, #ef4444 80%, #ef4444 100%)"
    }
  }, pct != null && /*#__PURE__*/React.createElement("div", {
    className: "absolute -top-1.5 h-6 w-0.5 rounded-full bg-text shadow-[0_0_6px_rgba(255,255,255,0.8)]",
    style: {
      left: pct + "%"
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "relative h-3 text-[0.6rem] text-textFaint"
  }, marcas.map((m, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: "absolute -translate-x-1/2",
    style: {
      left: (m - MIN) / (MAX - MIN) * 100 + "%"
    }
  }, m))));
}

/* ---------- Modal de ajuste de zoom/posição da foto de perfil ---------- */
const TAM_AJUSTE_FOTO = 240;
function AjusteFotoModal({
  src,
  onCancelar,
  onConfirmar
}) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const arrastoRef = useRef(null);
  const [imgPronta, setImgPronta] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({
    x: 0,
    y: 0
  });
  useEffect(() => {
    let cancelado = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelado) {
        imgRef.current = img;
        setImgPronta(true);
      }
    };
    img.src = src;
    return () => {
      cancelado = true;
    };
  }, [src]);
  useEffect(() => {
    if (!imgPronta) return;
    const img = imgRef.current;
    const escalaBase = Math.max(TAM_AJUSTE_FOTO / img.width, TAM_AJUSTE_FOTO / img.height);
    const escala = escalaBase * zoom;
    const largura = img.width * escala;
    const altura = img.height * escala;
    const maxX = Math.max(0, (largura - TAM_AJUSTE_FOTO) / 2);
    const maxY = Math.max(0, (altura - TAM_AJUSTE_FOTO) / 2);
    const x = Math.max(-maxX, Math.min(maxX, pan.x));
    const y = Math.max(-maxY, Math.min(maxY, pan.y));
    if (x !== pan.x || y !== pan.y) {
      setPan({
        x,
        y
      });
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, TAM_AJUSTE_FOTO, TAM_AJUSTE_FOTO);
    ctx.drawImage(img, TAM_AJUSTE_FOTO / 2 - largura / 2 + x, TAM_AJUSTE_FOTO / 2 - altura / 2 + y, largura, altura);
  }, [imgPronta, zoom, pan]);
  const onPointerDown = e => {
    e.currentTarget.setPointerCapture(e.pointerId);
    arrastoRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y
    };
  };
  const onPointerMove = e => {
    if (!arrastoRef.current) return;
    const dx = e.clientX - arrastoRef.current.startX;
    const dy = e.clientY - arrastoRef.current.startY;
    setPan({
      x: arrastoRef.current.panX + dx,
      y: arrastoRef.current.panY + dy
    });
  };
  const onPointerUp = () => {
    arrastoRef.current = null;
  };
  const confirmar = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onConfirmar(canvas.toDataURL("image/jpeg", 0.82));
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card flex w-full max-w-sm flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Ajustar foto"), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-center"
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: canvasRef,
    width: TAM_AJUSTE_FOTO,
    height: TAM_AJUSTE_FOTO,
    className: "touch-none cursor-move rounded-full border border-border",
    onPointerDown: onPointerDown,
    onPointerMove: onPointerMove,
    onPointerUp: onPointerUp,
    onPointerLeave: onPointerUp
  })), /*#__PURE__*/React.createElement("p", {
    className: "text-center text-xs text-textFaint"
  }, "Arraste para posicionar e use o controle abaixo para dar zoom."), /*#__PURE__*/React.createElement("div", {
    className: "px-2"
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Zoom"
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "1",
    max: "3",
    step: "0.01",
    value: zoom,
    onChange: e => setZoom(parseFloat(e.target.value))
  }))), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end gap-3 pt-1"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onCancelar,
    className: "rounded-lg border border-border px-4 py-2 text-sm text-textMuted transition-colors hover:text-text"
  }, "Cancelar"), /*#__PURE__*/React.createElement("button", {
    onClick: confirmar,
    className: "rounded-lg bg-red px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-red/80"
  }, "Aplicar"))));
}
function Perfil({
  irPara
}) {
  const {
    unidadePeso
  } = useConfig();
  const [perfil, setPerfil] = useLocalStorage("perfil", PERFIL_INICIAL);
  const [planos] = useLocalStorage("planos", {});
  const [sessoes] = useLocalStorage("treinos-log", []);
  const [draft, setDraft] = useState(perfil);
  const [salvo, setSalvo] = useState(false);
  const [editando, setEditando] = useState(!(perfil.nome || perfil.peso || perfil.altura));
  const [fotoBruta, setFotoBruta] = useState(null);
  const [mostrarDados, setMostrarDados] = useState(true);
  const fileInputRef = useRef(null);
  const update = campo => e => setDraft(p => ({
    ...p,
    [campo]: e.target.value
  }));
  const nivelInfo = useMemo(() => calcularNivelXP(calcularXP(calcularStatsSessoes(sessoes))), [sessoes]);
  const tier = tierDoNivel(nivelInfo.nivel);
  const {
    conquistasDesbloqueadas,
    totalConquistas
  } = useMemo(() => {
    const stats = calcularStatsSessoes(sessoes);
    const todosItens = CONQUISTAS_CONFIG.flatMap(g => g.itens);
    return {
      totalConquistas: todosItens.length,
      conquistasDesbloqueadas: todosItens.filter(item => stats[item.campo] >= item.meta).length
    };
  }, [sessoes]);
  const diaHoje = useMemo(() => {
    const diaJs = new Date().getDay(); // 0 = domingo
    return diaJs === 0 ? "Domingo" : DIAS_SEMANA[diaJs - 1];
  }, []);
  const gruposDeHoje = useMemo(() => {
    const blocos = planos[diaHoje] || [];
    return [...new Set(blocos.filter(b => b.exercicios.length > 0).map(b => b.grupo))];
  }, [planos, diaHoje]);
  const salvarPerfil = () => {
    setPerfil(draft);
    setEditando(false);
    setSalvo(true);
    setTimeout(() => setSalvo(false), 2200);
  };
  const iniciarEdicao = () => {
    setDraft(perfil);
    setEditando(true);
  };
  const onFotoSelecionada = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const leitor = new FileReader();
    leitor.onload = ev => setFotoBruta(ev.target.result);
    leitor.readAsDataURL(file);
  };
  const iniciais = (draft.nome || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
  const {
    imc,
    imcClasse,
    pesoIdeal,
    tmb
  } = useMemo(() => {
    const pesoKg = parseFloat(draft.peso);
    const alturaCm = parseFloat(draft.altura);
    const idade = parseInt(draft.idade, 10);
    const imcCalc = calcularIMC(pesoKg, alturaCm);
    return {
      imc: imcCalc,
      imcClasse: classificarIMC(imcCalc),
      pesoIdeal: calcularPesoIdeal(alturaCm, draft.sexo),
      tmb: calcularTMB(pesoKg, alturaCm, idade, draft.sexo)
    };
  }, [draft]);
  const campoDesabilitado = !editando;
  const classeInput = campoDesabilitado ? "opacity-60 cursor-not-allowed" : "";
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-6 fade-up"
  }, /*#__PURE__*/React.createElement("header", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Perfil"), /*#__PURE__*/React.createElement("h1", {
    className: "font-display text-2xl font-semibold"
  }, "Seus dados")), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-3 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Treino de hoje \xB7 ", diaHoje), gruposDeHoje.length > 0 ? /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-2 pl-2"
  }, gruposDeHoje.map(grupo => /*#__PURE__*/React.createElement("span", {
    key: grupo,
    className: "rounded-full border border-red/40 bg-red/10 px-3 py-1.5 text-sm font-medium text-text"
  }, grupo))) : /*#__PURE__*/React.createElement("span", {
    className: "pl-2 text-sm text-textMuted"
  }, "Nenhum treino planejado para hoje.")), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col items-center gap-4 p-6"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => editando && fileInputRef.current && fileInputRef.current.click(),
    className: "anel-nivel " + tier.classe + " " + (editando ? "cursor-pointer" : "cursor-default")
  }, /*#__PURE__*/React.createElement("span", {
    className: "group relative block h-32 w-32 overflow-hidden rounded-full border-4 border-bg bg-surface2 sm:h-36 sm:w-36"
  }, draft.foto ? /*#__PURE__*/React.createElement("img", {
    src: draft.foto,
    alt: "Foto de perfil",
    className: "h-full w-full object-cover"
  }) : /*#__PURE__*/React.createElement("span", {
    className: "flex h-full w-full items-center justify-center font-display text-4xl text-textMuted"
  }, iniciais), editando && /*#__PURE__*/React.createElement("span", {
    className: "absolute inset-0 flex items-center justify-center bg-black/50 text-xs font-medium text-text opacity-0 transition-opacity group-hover:opacity-100"
  }, "Alterar foto"))), /*#__PURE__*/React.createElement("input", {
    ref: fileInputRef,
    type: "file",
    accept: "image/*",
    className: "hidden",
    onChange: onFotoSelecionada,
    disabled: campoDesabilitado
  }), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col items-center gap-1 text-center"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "N\xEDvel ", nivelInfo.nivel, " \xB7 ", tier.label), /*#__PURE__*/React.createElement("h2", {
    className: "font-display text-3xl font-bold text-text"
  }, draft.nome || "Seu nome"), /*#__PURE__*/React.createElement("span", {
    className: "text-sm text-textMuted"
  }, nivelInfo.titulo)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => irPara && irPara("conquistas"),
    className: "flex items-center gap-2 rounded-full border border-border bg-surface2 px-4 py-2 text-sm font-medium text-text transition-colors hover:border-gold/50"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\uD83C\uDFC5"), /*#__PURE__*/React.createElement("span", {
    className: "tabular"
  }, conquistasDesbloqueadas, "/", totalConquistas)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setMostrarDados(v => !v),
    className: "flex items-center gap-1.5 pt-1 text-xs font-medium text-textMuted transition-colors hover:text-text"
  }, mostrarDados ? "Ocultar dados" : "Mostrar dados", /*#__PURE__*/React.createElement("span", {
    className: "inline-block transition-transform " + (mostrarDados ? "rotate-180" : "")
  }, "\u2304"))), mostrarDados && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 gap-4 pl-2 sm:grid-cols-2"
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Nome"
  }, /*#__PURE__*/React.createElement("input", {
    value: draft.nome,
    onChange: update("nome"),
    placeholder: "Seu nome",
    disabled: campoDesabilitado,
    className: classeInput
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Idade"
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    value: draft.idade,
    onChange: update("idade"),
    placeholder: "Ex: 28",
    disabled: campoDesabilitado,
    className: classeInput
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Altura (cm)"
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    value: draft.altura,
    onChange: update("altura"),
    placeholder: "Ex: 175",
    disabled: campoDesabilitado,
    className: classeInput
  })), /*#__PURE__*/React.createElement(CampoPeso, {
    label: "Peso atual",
    valorKg: draft.peso,
    onChangeKg: v => setDraft(p => ({
      ...p,
      peso: v
    })),
    placeholder: "Ex: 78.5",
    disabled: campoDesabilitado,
    className: classeInput
  }), /*#__PURE__*/React.createElement(Field, {
    label: "Objetivo"
  }, /*#__PURE__*/React.createElement("select", {
    value: draft.objetivo,
    onChange: update("objetivo"),
    disabled: campoDesabilitado,
    className: classeInput
  }, OBJETIVOS.map(o => /*#__PURE__*/React.createElement("option", {
    key: o,
    value: o
  }, o)))), /*#__PURE__*/React.createElement(CampoPeso, {
    label: "Peso objetivo",
    valorKg: draft.pesoObjetivo || "",
    onChangeKg: v => setDraft(p => ({
      ...p,
      pesoObjetivo: v
    })),
    placeholder: "Ex: 72",
    disabled: campoDesabilitado,
    className: classeInput
  }), /*#__PURE__*/React.createElement(Field, {
    label: "Sexo"
  }, /*#__PURE__*/React.createElement("select", {
    value: draft.sexo,
    onChange: update("sexo"),
    disabled: campoDesabilitado,
    className: classeInput
  }, /*#__PURE__*/React.createElement("option", {
    value: "masculino"
  }, "Masculino"), /*#__PURE__*/React.createElement("option", {
    value: "feminino"
  }, "Feminino")))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3 pl-2 pt-1"
  }, editando ? /*#__PURE__*/React.createElement("button", {
    onClick: salvarPerfil,
    className: "rounded-lg bg-red px-5 py-2.5 text-sm font-medium text-text transition-colors hover:bg-red/80"
  }, "Salvar perfil") : /*#__PURE__*/React.createElement("button", {
    onClick: iniciarEdicao,
    className: "rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-text transition-colors hover:border-red hover:text-red"
  }, "Editar perfil"), salvo && /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-medium text-green-400 fade-up"
  }, "\u2713 Perfil salvo!"))), /*#__PURE__*/React.createElement("section", {
    className: "flex flex-col gap-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow px-1"
  }, "Calculado automaticamente"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3 sm:grid-cols-4"
  }, /*#__PURE__*/React.createElement(StatCard, {
    label: "IMC",
    value: imc ? imc.toFixed(1) : "—",
    hint: imc ? imcClasse : "preencha altura e peso",
    icon: "raio"
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "Peso Ideal",
    value: pesoIdeal ? exibirPeso(pesoIdeal, unidadePeso) : "—",
    unit: pesoIdeal ? rotuloPeso(unidadePeso) : "",
    hint: "estimativa (Devine)",
    icon: "balanca"
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "TMB",
    value: tmb ? Math.round(tmb) : "—",
    unit: tmb ? "kcal/dia" : "",
    hint: "gasto em repouso",
    icon: "alvo"
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "Altura",
    value: draft.altura || "—",
    unit: draft.altura ? "cm" : "",
    hint: "informado",
    icon: "altura"
  })))), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-3 p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between pl-2 pr-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Faixa de IMC"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-medium text-text"
  }, imc ? `${imc.toFixed(1)} · ${imcClasse}` : "—")), /*#__PURE__*/React.createElement(IMCBar, {
    imc: imc
  })), fotoBruta && /*#__PURE__*/React.createElement(AjusteFotoModal, {
    src: fotoBruta,
    onCancelar: () => setFotoBruta(null),
    onConfirmar: dataUrl => {
      setDraft(p => ({
        ...p,
        foto: dataUrl
      }));
      setFotoBruta(null);
    }
  }));
}

/* ---------- Estatísticas ---------- */
const PERIODOS_ESTATISTICA = [{
  id: 7,
  label: "7 dias"
}, {
  id: 30,
  label: "30 dias"
}, {
  id: 90,
  label: "90 dias"
}, {
  id: 0,
  label: "Tudo"
}];
function BarraEvolucao({
  titulo,
  subtitulo,
  dados,
  corBarra
}) {
  const maximo = Math.max(1, ...dados.map(d => d.valor));
  return /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-0.5 pl-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, titulo), subtitulo && /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textFaint"
  }, subtitulo)), /*#__PURE__*/React.createElement("div", {
    className: "flex items-end gap-2 overflow-x-auto pb-1 pl-2"
  }, dados.map((d, i) => {
    const alturaPct = Math.max(4, d.valor / maximo * 100);
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "flex flex-col items-center gap-1",
      style: {
        minWidth: "26px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex h-28 w-3.5 items-end overflow-hidden rounded-full bg-surface2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-full rounded-full",
      style: {
        height: alturaPct + "%",
        background: corBarra
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "text-[0.6rem] text-textFaint"
    }, d.label));
  })));
}
function calcularProgressoPeso(pesoInicial, pesoAtual, pesoObjetivo) {
  if (!pesoInicial || !pesoAtual || !pesoObjetivo || pesoInicial === pesoObjetivo) return null;
  const total = pesoObjetivo - pesoInicial;
  const feito = pesoAtual - pesoInicial;
  return Math.max(0, Math.min(100, feito / total * 100));
}

/* ---------- Estatísticas: helpers novos (resumo, tendência, recordes,
   grupos musculares, heatmap, gráfico de peso e exportação em imagem) ---------- */

function somarStats(lista) {
  return lista.reduce((t, s) => ({
    totalTreinos: t.totalTreinos + 1,
    totalCarga: t.totalCarga + (s.cargaTotal || 0),
    totalCalorias: t.totalCalorias + (s.calorias || 0),
    totalSeries: t.totalSeries + (s.seriesConcluidas || 0)
  }), {
    totalTreinos: 0,
    totalCarga: 0,
    totalCalorias: 0,
    totalSeries: 0
  });
}
function CardResumoNumero({
  label,
  valor,
  sufixo
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex flex-col gap-1 p-4"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-1"
  }, label), /*#__PURE__*/React.createElement("span", {
    className: "font-display tabular pl-1 text-2xl font-bold text-text"
  }, valor, sufixo && /*#__PURE__*/React.createElement("span", {
    className: "ml-1 text-sm font-medium text-textFaint"
  }, sufixo)));
}
function Tendencia({
  atual,
  anterior
}) {
  if (anterior === 0 && atual === 0) return /*#__PURE__*/React.createElement("span", {
    className: "text-textFaint"
  }, "\u2014 sem dados no per\xEDodo anterior");
  if (anterior === 0) return /*#__PURE__*/React.createElement("span", {
    className: "text-green-400"
  }, "\u2191 novo neste per\xEDodo");
  const delta = (atual - anterior) / anterior * 100;
  const arredondado = Math.round(Math.abs(delta));
  if (delta > 0.5) return /*#__PURE__*/React.createElement("span", {
    className: "text-green-400"
  }, "\u2191 ", arredondado, "% vs per\xEDodo anterior");
  if (delta < -0.5) return /*#__PURE__*/React.createElement("span", {
    className: "text-red"
  }, "\u2193 ", arredondado, "% vs per\xEDodo anterior");
  return /*#__PURE__*/React.createElement("span", {
    className: "text-textFaint"
  }, "\u2248 igual ao per\xEDodo anterior");
}
function BarraGrupoMuscular({
  grupo,
  qtd,
  pct,
  corBarra
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1 pl-2 pr-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between text-xs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-text"
  }, grupo), /*#__PURE__*/React.createElement("span", {
    className: "tabular text-textFaint"
  }, qtd)), /*#__PURE__*/React.createElement("div", {
    className: "h-2 w-full overflow-hidden rounded-full bg-surface2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-full rounded-full transition-all",
    style: {
      width: Math.max(4, pct) + "%",
      background: corBarra
    }
  })));
}

/* mini calendário de consistência (estilo heatmap), últimas 10 semanas */
function HeatmapConsistencia({
  sessoes
}) {
  const semanas = useMemo(() => {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const mapaCarga = {};
    sessoes.forEach(s => {
      const d = new Date(s.data);
      d.setHours(0, 0, 0, 0);
      const chave = d.toDateString();
      mapaCarga[chave] = (mapaCarga[chave] || 0) + (s.cargaTotal || 0);
    });
    const totalDias = 70;
    const inicioGrid = inicioDaSemana(new Date(hoje.getTime() - (totalDias - 1) * 24 * 60 * 60 * 1000));
    const dias = [];
    for (let i = 0; i < totalDias + 7; i++) {
      const d = new Date(inicioGrid);
      d.setDate(inicioGrid.getDate() + i);
      if (d > hoje) break;
      dias.push({
        data: d,
        carga: mapaCarga[d.toDateString()] || 0
      });
    }
    const grupos = [];
    for (let i = 0; i < dias.length; i += 7) grupos.push(dias.slice(i, i + 7));
    return grupos;
  }, [sessoes]);
  const maximo = Math.max(1, ...semanas.flat().map(d => d.carga));
  const nivel = carga => {
    if (carga <= 0) return 0;
    const r = carga / maximo;
    if (r > 0.66) return 3;
    if (r > 0.33) return 2;
    return 1;
  };
  const cores = ["rgb(var(--c-surface2))", "rgba(214,0,0,0.35)", "rgba(214,0,0,0.65)", "#d60000"];
  return /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-3 p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-0.5 pl-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Consist\xEAncia"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textFaint"
  }, "\xDAltimos 70 dias \xB7 quanto mais vermelho, maior a carga do dia")), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-[3px] overflow-x-auto pb-1 pl-2"
  }, semanas.map((semana, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "flex flex-col gap-[3px]"
  }, semana.map((d, j) => /*#__PURE__*/React.createElement("div", {
    key: j,
    title: d.data.toLocaleDateString("pt-BR") + (d.carga > 0 ? " · " + Math.round(d.carga) + " kg movimentados" : " · sem treino"),
    className: "h-3 w-3 rounded-[3px]",
    style: {
      background: cores[nivel(d.carga)]
    }
  }))))));
}

/* gráfico de linha simples (SVG) pra evolução de peso */
function GraficoPeso({
  historico,
  unidadePeso
}) {
  if (historico.length < 2) {
    return /*#__PURE__*/React.createElement("p", {
      className: "pl-2 text-xs text-textFaint"
    }, "Registre pelo menos 2 pesagens pra ver o gr\xE1fico de evolu\xE7\xE3o.");
  }
  const largura = 600;
  const altura = 120;
  const pad = 12;
  const valores = historico.map(h => h.peso);
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  const faixa = max - min || 1;
  const pontos = historico.map((h, i) => {
    const x = pad + i / (historico.length - 1) * (largura - pad * 2);
    const y = altura - pad - (h.peso - min) / faixa * (altura - pad * 2);
    return {
      x,
      y,
      peso: h.peso
    };
  });
  const linha = pontos.map(p => p.x + "," + p.y).join(" ");
  const areaPath = "M" + pad + "," + altura + " L" + linha + " L" + (largura - pad) + "," + altura + " Z";
  return /*#__PURE__*/React.createElement("div", {
    className: "pl-2 pr-2"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 " + largura + " " + altura,
    className: "w-full",
    preserveAspectRatio: "none",
    style: {
      height: "120px"
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: areaPath,
    fill: "rgba(214,0,0,0.12)",
    stroke: "none"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: linha,
    fill: "none",
    stroke: "#d60000",
    strokeWidth: "2.5",
    strokeLinejoin: "round",
    strokeLinecap: "round"
  }), pontos.map((p, i) => /*#__PURE__*/React.createElement("circle", {
    key: i,
    cx: p.x,
    cy: p.y,
    r: i === pontos.length - 1 ? 4 : 2.5,
    fill: i === pontos.length - 1 ? "#d60000" : "rgb(var(--c-text))"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "mt-1 flex justify-between text-[0.65rem] text-textFaint"
  }, /*#__PURE__*/React.createElement("span", null, "Menor: ", exibirPeso(min, unidadePeso), " ", rotuloPeso(unidadePeso)), /*#__PURE__*/React.createElement("span", null, "Maior: ", exibirPeso(max, unidadePeso), " ", rotuloPeso(unidadePeso))));
}

/* gera e baixa uma imagem PNG com o resumo do progresso, pra compartilhar */
function exportarResumoImagem({
  periodoLabel,
  resumo
}) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, "#0d0d0d");
  grad.addColorStop(1, "#1a0505");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#d60000";
  ctx.font = "bold 50px Arial";
  ctx.fillText("SMART COLISEU", 60, 110);
  ctx.fillStyle = "#9a9a9a";
  ctx.font = "28px Arial";
  ctx.fillText("Meu progresso · " + periodoLabel, 60, 155);
  const linhas = [["Treinos concluídos", String(resumo.totalTreinos)], ["Carga total movimentada", Math.round(resumo.totalCarga).toLocaleString("pt-BR") + " kg"], ["Calorias queimadas", Math.round(resumo.totalCalorias).toLocaleString("pt-BR") + " kcal"], ["Séries completas", String(resumo.totalSeries)]];
  let y = 300;
  linhas.forEach(([label, valor]) => {
    ctx.fillStyle = "#f5f5f5";
    ctx.font = "bold 68px Arial";
    ctx.fillText(valor, 60, y);
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "26px Arial";
    ctx.fillText(label, 60, y + 38);
    y += 160;
  });
  ctx.fillStyle = "#5c5c5c";
  ctx.font = "22px Arial";
  ctx.fillText("smartlinkdigital.com.br", 60, canvas.height - 50);
  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "smart-coliseu-progresso.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

/* recordes pessoais por exercício: pra cada exercício já feito, junta o
   histórico de carga (uma amostra por sessão, pegando a maior carga daquele
   exercício naquele treino) e aponta o PR (maior carga já registrada) com
   a data em que ele foi batido. Usado na seção "Recordes por exercício". */
function calcularRecordesPorExercicio(sessoes) {
  const porExercicio = {};
  [...sessoes].sort((a, b) => a.data - b.data).forEach(s => {
    (s.detalhes || []).forEach(d => {
      if (!d.nome || !(d.carga > 0)) return;
      if (!porExercicio[d.nome]) porExercicio[d.nome] = {
        nome: d.nome,
        grupo: d.grupo,
        historico: []
      };
      const ultimo = porExercicio[d.nome].historico;
      const pontoAnterior = ultimo[ultimo.length - 1];
      // uma amostra por sessão: se o mesmo treino já tem ponto, fica com a maior carga dele
      if (pontoAnterior && pontoAnterior.data === s.data) {
        pontoAnterior.carga = Math.max(pontoAnterior.carga, d.carga);
      } else {
        ultimo.push({
          data: s.data,
          carga: d.carga
        });
      }
    });
  });
  return Object.values(porExercicio).map(ex => {
    let pr = ex.historico[0];
    ex.historico.forEach(p => {
      if (p.carga > pr.carga) pr = p;
    });
    const primeiro = ex.historico[0];
    const evolucaoPct = primeiro && primeiro.carga > 0 ? (pr.carga - primeiro.carga) / primeiro.carga * 100 : 0;
    return {
      ...ex,
      pr,
      evolucaoPct
    };
  }).sort((a, b) => b.pr.data - a.pr.data);
}

/* mini gráfico de linha (sparkline) sem eixo/legenda, só pra mostrar a
   tendência de evolução de carga de um exercício de forma compacta. */
function Sparkline({
  pontos,
  corLinha = "#d60000"
}) {
  if (pontos.length < 2) {
    return /*#__PURE__*/React.createElement("div", {
      className: "flex h-10 w-full items-center text-[0.65rem] text-textFaint"
    }, "ainda sem hist\xF3rico suficiente");
  }
  const w = 200,
    h = 40,
    pad = 4;
  const valores = pontos.map(p => p.carga);
  const min = Math.min(...valores),
    max = Math.max(...valores);
  const faixa = max - min || 1;
  const coords = pontos.map((p, i) => {
    const x = pad + i / (pontos.length - 1) * (w - pad * 2);
    const y = h - pad - (p.carga - min) / faixa * (h - pad * 2);
    return [x, y];
  });
  const path = coords.map(([x, y], i) => (i === 0 ? "M" : "L") + x + " " + y).join(" ");
  const [ultimoX, ultimoY] = coords[coords.length - 1];
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 " + w + " " + h,
    className: "h-10 w-full",
    preserveAspectRatio: "none"
  }, /*#__PURE__*/React.createElement("path", {
    d: path,
    fill: "none",
    stroke: corLinha,
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: ultimoX,
    cy: ultimoY,
    r: "3",
    fill: corLinha
  }));
}
function RecordesPorExercicio({
  sessoes,
  unidadePeso
}) {
  const [busca, setBusca] = useState("");
  const [expandido, setExpandido] = useState(false);
  const recordes = useMemo(() => calcularRecordesPorExercicio(sessoes), [sessoes]);
  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    const base = termo ? recordes.filter(r => r.nome.toLowerCase().includes(termo)) : recordes;
    return expandido ? base : base.slice(0, 5);
  }, [recordes, busca, expandido]);
  if (recordes.length === 0) return null;
  return /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-3 p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-2 pl-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Recordes por exerc\xEDcio"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textFaint"
  }, recordes.length, " exerc\xEDcio", recordes.length > 1 ? "s" : "")), recordes.length > 5 && /*#__PURE__*/React.createElement("input", {
    value: busca,
    onChange: e => setBusca(e.target.value),
    placeholder: "Buscar exerc\xEDcio...",
    className: "mx-2 rounded-lg border border-border bg-surface2 px-3 py-2 text-sm text-text outline-none focus:border-red/50"
  }), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col divide-y divide-borderSoft"
  }, filtrados.map(ex => /*#__PURE__*/React.createElement("div", {
    key: ex.nome,
    className: "flex flex-col gap-2 py-3 pl-2 pr-1 first:pt-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-start justify-between gap-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-sm font-medium text-text"
  }, ex.nome), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textFaint"
  }, ex.grupo, " \xB7 PR em ", new Date(ex.pr.data).toLocaleDateString("pt-BR"))), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col items-end shrink-0"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-display tabular text-lg font-semibold text-gold"
  }, exibirPeso(ex.pr.carga, unidadePeso, 0), /*#__PURE__*/React.createElement("span", {
    className: "ml-1 text-xs text-textFaint"
  }, rotuloPeso(unidadePeso))), ex.evolucaoPct !== 0 && /*#__PURE__*/React.createElement("span", {
    className: "text-[0.65rem] font-medium " + (ex.evolucaoPct > 0 ? "text-green-400" : "text-textFaint")
  }, ex.evolucaoPct > 0 ? "▲" : "▼", " ", Math.abs(Math.round(ex.evolucaoPct)), "% desde o in\xEDcio"))), /*#__PURE__*/React.createElement(Sparkline, {
    pontos: ex.historico,
    corLinha: "#e0a530"
  })))), !expandido && recordes.length > 5 && /*#__PURE__*/React.createElement("button", {
    onClick: () => setExpandido(true),
    className: "self-start pl-2 text-xs font-medium text-red transition-colors hover:text-red/80"
  }, "Ver todos os ", recordes.length, " exerc\xEDcios \u2192"));
}
const CAMPOS_MEDIDAS = [{
  chave: "braco",
  label: "Braço"
}, {
  chave: "peito",
  label: "Peito"
}, {
  chave: "cintura",
  label: "Cintura"
}, {
  chave: "coxa",
  label: "Coxa"
}];

/* seção de medidas corporais (além do peso): guarda um histórico próprio
   em localStorage, cada registro com data + os 4 campos. Mostra o valor
   mais recente de cada medida com a variação em cm desde o registro
   anterior, e um formulário compacto pra adicionar uma nova rodada. */
function MedidasCorporais() {
  const [historico, setHistorico] = useLocalStorage("medidas-historico", []);
  const [draft, setDraft] = useState({
    braco: "",
    peito: "",
    cintura: "",
    coxa: ""
  });
  const [salvo, setSalvo] = useState(false);
  const ultimo = historico.length > 0 ? historico[historico.length - 1] : null;
  const penultimo = historico.length > 1 ? historico[historico.length - 2] : null;
  const algumPreenchido = Object.values(draft).some(v => v !== "");
  const salvarMedidas = () => {
    const registro = {
      data: Date.now()
    };
    CAMPOS_MEDIDAS.forEach(({
      chave
    }) => {
      const valor = parseFloat(draft[chave]);
      registro[chave] = valor > 0 ? valor : ultimo ? ultimo[chave] : undefined;
    });
    setHistorico(prev => [...prev, registro]);
    setDraft({
      braco: "",
      peito: "",
      cintura: "",
      coxa: ""
    });
    setSalvo(true);
    setTimeout(() => setSalvo(false), 2200);
  };
  return /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between pl-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Medidas corporais"), ultimo && /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textFaint"
  }, "atualizado em ", new Date(ultimo.data).toLocaleDateString("pt-BR"))), ultimo && /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3 sm:grid-cols-4"
  }, CAMPOS_MEDIDAS.map(({
    chave,
    label
  }) => {
    const atual = ultimo[chave];
    const anterior = penultimo ? penultimo[chave] : null;
    const delta = atual != null && anterior != null ? atual - anterior : null;
    return /*#__PURE__*/React.createElement("div", {
      key: chave,
      className: "rounded-lg border border-border bg-surface2 p-3"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-[0.65rem] text-textFaint"
    }, label), /*#__PURE__*/React.createElement("div", {
      className: "flex items-baseline gap-1"
    }, /*#__PURE__*/React.createElement("span", {
      className: "font-display tabular text-lg font-semibold text-text"
    }, atual != null ? atual : "—"), /*#__PURE__*/React.createElement("span", {
      className: "text-xs text-textMuted"
    }, "cm")), delta != null && delta !== 0 && /*#__PURE__*/React.createElement("span", {
      className: "text-[0.65rem] font-medium " + (delta > 0 ? "text-green-400" : "text-red")
    }, delta > 0 ? "▲" : "▼", " ", Math.abs(delta).toFixed(1), " cm"));
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-3 pl-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-medium text-textMuted"
  }, ultimo ? "Nova medição (deixe em branco o que não mudou)" : "Registrar primeira medição"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3 sm:grid-cols-4"
  }, CAMPOS_MEDIDAS.map(({
    chave,
    label
  }) => /*#__PURE__*/React.createElement(Field, {
    key: chave,
    label: label + " (cm)"
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    inputMode: "decimal",
    step: "0.5",
    min: "0",
    value: draft[chave],
    onChange: e => setDraft(d => ({
      ...d,
      [chave]: e.target.value
    })),
    placeholder: ultimo && ultimo[chave] != null ? String(ultimo[chave]) : "Ex: 38",
    className: "rounded-lg border border-border bg-surface2 px-3 py-2 text-sm text-text outline-none focus:border-red/50"
  })))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: salvarMedidas,
    disabled: !algumPreenchido,
    className: "self-start rounded-lg bg-red px-4 py-2.5 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:bg-red/80"
  }, "Salvar medidas"), salvo && /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-medium text-green-400 fade-up"
  }, "\u2713 Medidas salvas!"))), historico.length > 0 && /*#__PURE__*/React.createElement("p", {
    className: "pl-2 text-xs text-textFaint"
  }, historico.length, " medi\xE7\xE3o", historico.length > 1 ? "ões" : "", " registrada", historico.length > 1 ? "s" : "", " no total."));
}
function Estatisticas() {
  const {
    unidadePeso
  } = useConfig();
  const [sessoes] = useLocalStorage("treinos-log", []);
  const [perfil, setPerfil] = useLocalStorage("perfil", PERFIL_INICIAL);
  const [historicoPeso, setHistoricoPeso] = useLocalStorage("peso-historico", []);
  const [novoPeso, setNovoPeso] = useState("");
  const [periodo, setPeriodo] = useState(7);
  const [confirmandoLimparPeso, setConfirmandoLimparPeso] = useState(false);
  const salvarPeso = () => {
    const valor = parseFloat(novoPeso);
    if (!valor) return;
    setPerfil(p => ({
      ...p,
      peso: String(valor)
    }));
    setHistoricoPeso(prev => {
      const ultimo = prev.length > 0 ? prev[prev.length - 1] : null;
      // se o peso for igual ao último registrado, só atualiza a data desse
      // registro (sem empilhar um ponto novo) — o gráfico só deve variar
      // quando o peso realmente subir ou descer
      if (ultimo && ultimo.peso === valor) {
        return [...prev.slice(0, -1), {
          data: Date.now(),
          peso: valor
        }];
      }
      return [...prev, {
        data: Date.now(),
        peso: valor
      }];
    });
    setNovoPeso("");
  };

  /* limpa os registros antigos de peso, mantendo só o mais recente como novo
     ponto de partida — útil quando o histórico tem dados de teste/antigos
     que estavam distorcendo o gráfico de evolução */
  const limparHistoricoPeso = () => {
    setHistoricoPeso(prev => prev.length > 0 ? [prev[prev.length - 1]] : prev);
    setConfirmandoLimparPeso(false);
  };
  const pesoObjetivoNum = parseFloat(perfil.pesoObjetivo) || null;
  const pesoInicial = historicoPeso.length > 0 ? historicoPeso[0].peso : parseFloat(perfil.peso) || null;
  const pesoAtualNum = historicoPeso.length > 0 ? historicoPeso[historicoPeso.length - 1].peso : parseFloat(perfil.peso) || null;
  const progressoPeso = calcularProgressoPeso(pesoInicial, pesoAtualNum, pesoObjetivoNum);
  const sessoesFiltradas = useMemo(() => {
    const agora = Date.now();
    const base = periodo === 0 ? sessoes : sessoes.filter(s => s.data >= agora - periodo * 24 * 60 * 60 * 1000);
    return [...base].sort((a, b) => a.data - b.data);
  }, [sessoes, periodo]);

  /* mesmo intervalo de tempo, mas imediatamente anterior ao período
     selecionado — usado só pra calcular a tendência (↑/↓ vs período anterior) */
  const sessoesPeriodoAnterior = useMemo(() => {
    if (periodo === 0) return [];
    const agora = Date.now();
    const inicioAtual = agora - periodo * 24 * 60 * 60 * 1000;
    const inicioAnterior = inicioAtual - periodo * 24 * 60 * 60 * 1000;
    return sessoes.filter(s => s.data >= inicioAnterior && s.data < inicioAtual);
  }, [sessoes, periodo]);
  const formatarData = ts => new Date(ts).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit"
  });
  const dadosCarga = sessoesFiltradas.map(s => ({
    label: formatarData(s.data),
    valor: s.cargaTotal || 0
  }));

  /* evolução no tempo de treino: quantidade de treinos concluídos por semana,
     dentro do período selecionado (7/30/90/tudo) */
  const dadosFrequenciaSemanal = useMemo(() => {
    const porSemana = {};
    sessoesFiltradas.forEach(s => {
      const chave = inicioDaSemana(new Date(s.data)).toDateString();
      porSemana[chave] = (porSemana[chave] || 0) + 1;
    });
    return Object.entries(porSemana).sort((a, b) => new Date(a[0]) - new Date(b[0])).map(([chave, qtd]) => ({
      label: formatarData(new Date(chave).getTime()),
      valor: qtd
    }));
  }, [sessoesFiltradas]);
  const resumo = useMemo(() => somarStats(sessoesFiltradas), [sessoesFiltradas]);
  const resumoAnterior = useMemo(() => somarStats(sessoesPeriodoAnterior), [sessoesPeriodoAnterior]);
  const distribuicaoGrupos = useMemo(() => {
    const mapa = {};
    sessoesFiltradas.forEach(s => (s.detalhes || []).forEach(d => {
      mapa[d.grupo] = (mapa[d.grupo] || 0) + 1;
    }));
    const total = Object.values(mapa).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(mapa).map(([grupo, qtd]) => ({
      grupo,
      qtd,
      pct: qtd / total * 100
    })).sort((a, b) => b.qtd - a.qtd).slice(0, 8);
  }, [sessoesFiltradas]);

  /* recordes olham pro histórico inteiro, não só pro período selecionado */
  const recordes = useMemo(() => {
    let maiorCargaExercicio = null;
    sessoes.forEach(s => (s.detalhes || []).forEach(d => {
      if (!maiorCargaExercicio || d.carga > maiorCargaExercicio.carga) maiorCargaExercicio = {
        nome: d.nome,
        carga: d.carga
      };
    }));
    let sessaoMaisSeries = null;
    sessoes.forEach(s => {
      if (!sessaoMaisSeries || (s.seriesConcluidas || 0) > sessaoMaisSeries.series) {
        sessaoMaisSeries = {
          series: s.seriesConcluidas || 0,
          data: s.data
        };
      }
    });
    const porSemana = {};
    sessoes.forEach(s => {
      const chave = inicioDaSemana(new Date(s.data)).toDateString();
      porSemana[chave] = (porSemana[chave] || 0) + 1;
    });
    let melhorSemana = null;
    Object.entries(porSemana).forEach(([chave, qtd]) => {
      if (!melhorSemana || qtd > melhorSemana.qtd) melhorSemana = {
        chave,
        qtd
      };
    });
    return {
      maiorCargaExercicio,
      sessaoMaisSeries,
      melhorSemana
    };
  }, [sessoes]);
  const periodoLabel = (PERIODOS_ESTATISTICA.find(p => p.id === periodo) || {}).label || "";
  const insight = useMemo(() => {
    if (sessoesFiltradas.length === 0) return null;
    if (periodo === 0) {
      return `Você já registrou ${resumo.totalTreinos} treinos no total, movimentando ${Math.round(resumo.totalCarga).toLocaleString("pt-BR")} kg de carga. Continue registrando pra ver sua evolução por período. 💪`;
    }
    const deltaTreinos = resumo.totalTreinos - resumoAnterior.totalTreinos;
    if (resumoAnterior.totalTreinos === 0 && resumo.totalTreinos > 0) {
      return `Você treinou ${resumo.totalTreinos} ${resumo.totalTreinos > 1 ? "vezes" : "vez"} nos últimos ${periodoLabel}, um período sem nenhum treino registrado antes. Bom começo! 🔥`;
    }
    if (deltaTreinos > 0) {
      return `Você treinou ${deltaTreinos} vez${deltaTreinos > 1 ? "es" : ""} a mais que no período anterior. Continue nesse ritmo! 🔥`;
    }
    if (deltaTreinos < 0) {
      return `Você treinou ${Math.abs(deltaTreinos)} vez${Math.abs(deltaTreinos) > 1 ? "es" : ""} a menos que no período anterior — bora recuperar o ritmo.`;
    }
    return `Mesmo número de treinos do período anterior (${resumo.totalTreinos}). Constância é o que constrói resultado. 💪`;
  }, [sessoesFiltradas, resumo, resumoAnterior, periodo, periodoLabel]);
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-6 fade-up"
  }, /*#__PURE__*/React.createElement("header", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Estat\xEDsticas"), /*#__PURE__*/React.createElement("h1", {
    className: "font-display text-2xl font-semibold"
  }, "Evolu\xE7\xE3o do treino"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, "Evolu\xE7\xE3o de carga e de frequ\xEAncia de treino ao longo do tempo.")), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-3 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Per\xEDodo"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-2 pl-2"
  }, PERIODOS_ESTATISTICA.map(p => /*#__PURE__*/React.createElement("button", {
    key: p.id,
    onClick: () => setPeriodo(p.id),
    className: "rounded-lg border px-3 py-2 text-sm transition-colors " + (periodo === p.id ? "border-red bg-red/10 text-text" : "border-border text-textMuted hover:text-text")
  }, p.label)))), sessoesFiltradas.length === 0 ? /*#__PURE__*/React.createElement(EstadoVazio, {
    icon: "estatisticas",
    titulo: "Nenhum treino registrado nesse per\xEDodo ainda",
    descricao: "Complete s\xE9ries em \"Planos de Treino\" para ver os dados aqui."
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, insight && /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex items-start gap-3 p-4"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xl"
  }, "\uD83D\uDCA1"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-text"
  }, insight)), /*#__PURE__*/React.createElement("section", {
    className: "grid grid-cols-2 gap-3 sm:grid-cols-4"
  }, /*#__PURE__*/React.createElement(CardResumoNumero, {
    label: "Treinos",
    valor: resumo.totalTreinos
  }), /*#__PURE__*/React.createElement(CardResumoNumero, {
    label: "Carga total",
    valor: Math.round(resumo.totalCarga).toLocaleString("pt-BR"),
    sufixo: "kg"
  }), /*#__PURE__*/React.createElement(CardResumoNumero, {
    label: "Calorias",
    valor: Math.round(resumo.totalCalorias).toLocaleString("pt-BR"),
    sufixo: "kcal"
  }), /*#__PURE__*/React.createElement(CardResumoNumero, {
    label: "S\xE9ries",
    valor: resumo.totalSeries
  })), periodo !== 0 && /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-2 p-4"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-1"
  }, "Tend\xEAncia vs per\xEDodo anterior"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-x-6 gap-y-1 pl-1 text-sm"
  }, /*#__PURE__*/React.createElement("span", null, "Treinos: ", /*#__PURE__*/React.createElement(Tendencia, {
    atual: resumo.totalTreinos,
    anterior: resumoAnterior.totalTreinos
  })), /*#__PURE__*/React.createElement("span", null, "Carga: ", /*#__PURE__*/React.createElement(Tendencia, {
    atual: resumo.totalCarga,
    anterior: resumoAnterior.totalCarga
  }))))), /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Peso semanal"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-3 pl-2 sm:flex-row sm:items-end"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex-1"
  }, /*#__PURE__*/React.createElement(CampoPeso, {
    label: "Atualizar peso desta semana",
    valorKg: novoPeso,
    onChangeKg: setNovoPeso,
    placeholder: "Ex: 78.5"
  })), /*#__PURE__*/React.createElement("button", {
    onClick: salvarPeso,
    disabled: !novoPeso,
    className: "rounded-lg px-4 py-2.5 text-sm font-medium text-text transition-colors disabled:cursor-not-allowed disabled:opacity-40",
    style: {
      backgroundColor: "#d60000"
    },
    onMouseEnter: e => {
      if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = "#b50000";
    },
    onMouseLeave: e => {
      e.currentTarget.style.backgroundColor = "#d60000";
    }
  }, "Salvar peso")), pesoObjetivoNum ? /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-2 pl-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between text-xs text-textMuted"
  }, /*#__PURE__*/React.createElement("span", null, "Progresso at\xE9 o objetivo (", exibirPeso(pesoObjetivoNum, unidadePeso), " ", rotuloPeso(unidadePeso), ")"), /*#__PURE__*/React.createElement("span", {
    className: "tabular text-text"
  }, progressoPeso != null ? Math.round(progressoPeso) + "%" : "—")), /*#__PURE__*/React.createElement("div", {
    className: "h-2.5 overflow-hidden rounded-full bg-surface2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-full rounded-full transition-all " + ((progressoPeso || 0) >= 100 ? "bg-green-400" : "bg-red"),
    style: {
      width: (progressoPeso || 0) + "%"
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between text-[0.65rem] text-textFaint"
  }, /*#__PURE__*/React.createElement("span", null, "In\xEDcio: ", pesoInicial != null ? exibirPeso(pesoInicial, unidadePeso) : "—", " ", rotuloPeso(unidadePeso)), /*#__PURE__*/React.createElement("span", null, "Atual: ", pesoAtualNum != null ? exibirPeso(pesoAtualNum, unidadePeso) : "—", " ", rotuloPeso(unidadePeso)))) : /*#__PURE__*/React.createElement("p", {
    className: "pl-2 text-xs text-textFaint"
  }, "Defina seu peso objetivo no Perfil para ver a barra de progresso."), /*#__PURE__*/React.createElement(GraficoPeso, {
    historico: historicoPeso,
    unidadePeso: unidadePeso
  }), historicoPeso.length > 0 && /*#__PURE__*/React.createElement("p", {
    className: "pl-2 text-xs text-textFaint"
  }, "\xDAltimo registro: ", /*#__PURE__*/React.createElement("span", {
    className: "text-text"
  }, exibirPeso(historicoPeso[historicoPeso.length - 1].peso, unidadePeso), " ", rotuloPeso(unidadePeso)), " ", "em ", new Date(historicoPeso[historicoPeso.length - 1].data).toLocaleDateString("pt-BR"), " ", "\xB7 ", historicoPeso.length, " ", historicoPeso.length > 1 ? "pesagens" : "pesagem", " registrada", historicoPeso.length > 1 ? "s" : ""), historicoPeso.length > 1 && /*#__PURE__*/React.createElement("div", {
    className: "pl-2"
  }, !confirmandoLimparPeso ? /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmandoLimparPeso(true),
    className: "text-xs font-medium text-textFaint underline decoration-dotted hover:text-red"
  }, "Limpar hist\xF3rico do gr\xE1fico (manter s\xF3 o registro atual: ", exibirPeso(historicoPeso[historicoPeso.length - 1].peso, unidadePeso), " ", rotuloPeso(unidadePeso), ")") : /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-2 fade-up"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textMuted"
  }, "Isso apaga os registros antigos e deixa s\xF3 o atual como novo ponto de partida. Confirma?"), /*#__PURE__*/React.createElement("button", {
    onClick: limparHistoricoPeso,
    className: "rounded-lg bg-red px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
  }, "Confirmar"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmandoLimparPeso(false),
    className: "rounded-lg border border-border px-3 py-1.5 text-xs text-textMuted hover:text-text"
  }, "Cancelar")))), /*#__PURE__*/React.createElement(MedidasCorporais, null), sessoesFiltradas.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(BarraEvolucao, {
    titulo: "Evolu\xE7\xE3o de carga",
    subtitulo: "Carga movimentada em cada treino",
    dados: dadosCarga,
    corBarra: "#d60000"
  }), /*#__PURE__*/React.createElement(BarraEvolucao, {
    titulo: "Evolu\xE7\xE3o no tempo de treino",
    subtitulo: "Treinos conclu\xEDdos por semana",
    dados: dadosFrequenciaSemanal,
    corBarra: "#d60000"
  }), distribuicaoGrupos.length > 0 && /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-3 p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-0.5 pl-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Distribui\xE7\xE3o por grupo muscular"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textFaint"
  }, "Exerc\xEDcios conclu\xEDdos por grupo, no per\xEDodo selecionado")), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-3"
  }, distribuicaoGrupos.map(g => /*#__PURE__*/React.createElement(BarraGrupoMuscular, {
    key: g.grupo,
    grupo: g.grupo,
    qtd: g.qtd,
    pct: g.pct,
    corBarra: "#d60000"
  }))))), /*#__PURE__*/React.createElement(HeatmapConsistencia, {
    sessoes: sessoes
  }), (recordes.maiorCargaExercicio || recordes.sessaoMaisSeries || recordes.melhorSemana) && /*#__PURE__*/React.createElement("section", {
    className: "card fade-up flex flex-col gap-3 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow pl-2"
  }, "Recordes pessoais"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-2"
  }, recordes.maiorCargaExercicio && /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3 pl-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xl"
  }, "\uD83C\uDFC6"), /*#__PURE__*/React.createElement("span", {
    className: "text-sm text-text"
  }, "Maior carga: ", /*#__PURE__*/React.createElement("span", {
    className: "font-semibold"
  }, Math.round(recordes.maiorCargaExercicio.carga), " kg"), " em ", recordes.maiorCargaExercicio.nome)), recordes.sessaoMaisSeries && /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3 pl-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xl"
  }, "\uD83C\uDFC6"), /*#__PURE__*/React.createElement("span", {
    className: "text-sm text-text"
  }, "Treino com mais s\xE9ries: ", /*#__PURE__*/React.createElement("span", {
    className: "font-semibold"
  }, recordes.sessaoMaisSeries.series, " s\xE9ries"), " em ", new Date(recordes.sessaoMaisSeries.data).toLocaleDateString("pt-BR"))), recordes.melhorSemana && /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3 pl-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xl"
  }, "\uD83C\uDFC6"), /*#__PURE__*/React.createElement("span", {
    className: "text-sm text-text"
  }, "Melhor semana: ", /*#__PURE__*/React.createElement("span", {
    className: "font-semibold"
  }, recordes.melhorSemana.qtd, " treinos"), " na semana de ", new Date(recordes.melhorSemana.chave).toLocaleDateString("pt-BR"))))), /*#__PURE__*/React.createElement(RecordesPorExercicio, {
    sessoes: sessoes,
    unidadePeso: unidadePeso
  }), sessoesFiltradas.length > 0 && /*#__PURE__*/React.createElement("button", {
    onClick: () => exportarResumoImagem({
      periodoLabel,
      resumo
    }),
    className: "self-start rounded-lg border border-red/60 px-4 py-2.5 text-sm font-medium text-red transition-colors hover:bg-red/10"
  }, "\uD83D\uDCE4 Compartilhar progresso"));
}

/* ---------- Dashboard ---------- */
function CardNivel({
  nivelInfo
}) {
  const faltam = nivelInfo.xpParaProximoNivel - nivelInfo.xpNoNivel;
  return /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex flex-col gap-3 p-5",
    style: {
      boxShadow: "0 1px 2px rgba(0,0,0,0.3), 0 0 32px -8px rgba(224,165,48,0.18)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col pl-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "N\xEDvel ", nivelInfo.nivel), /*#__PURE__*/React.createElement("span", {
    className: "font-display text-lg font-semibold text-text"
  }, nivelInfo.titulo)), /*#__PURE__*/React.createElement("span", {
    className: "text-2xl"
  }, "\uD83C\uDF96\uFE0F")), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1 pl-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-2 w-full overflow-hidden rounded-full bg-surface2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-full rounded-full bg-red transition-all",
    style: {
      width: nivelInfo.progresso + "%"
    }
  })), /*#__PURE__*/React.createElement("span", {
    className: "tabular text-xs text-textFaint"
  }, nivelInfo.xpNoNivel, " / ", nivelInfo.xpParaProximoNivel, " XP \xB7 faltam ", faltam, " XP p/ o n\xEDvel ", nivelInfo.nivel + 1)));
}
function CardStreakHero({
  streak
}) {
  const ativo = streak > 0;
  const streakAnimado = useCountUp(streak);
  return /*#__PURE__*/React.createElement("div", {
    className: "card fade-up relative flex flex-col items-center gap-4 overflow-hidden p-6 text-center sm:flex-row sm:items-center sm:justify-between sm:p-8 sm:text-left " + (ativo ? "border-gold/50" : "")
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow " + (ativo ? "text-gold" : "")
  }, "Sequ\xEAncia de treinos"), /*#__PURE__*/React.createElement("div", {
    className: "flex items-baseline justify-center gap-2 sm:justify-start"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-display tabular text-5xl font-bold sm:text-6xl " + (ativo ? "text-gold" : "text-text")
  }, ativo ? streakAnimado : "—"), /*#__PURE__*/React.createElement("span", {
    className: "text-base font-medium text-textFaint"
  }, ativo ? streak === 1 ? "dia seguido" : "dias seguidos" : "Comece hoje")), /*#__PURE__*/React.createElement("span", {
    className: "text-sm text-textMuted"
  }, ativo ? "Treine nos dias planejados pra manter o fogo aceso." : "Treine num dia planejado pra iniciar sua sequência.")), /*#__PURE__*/React.createElement("span", {
    className: "flex h-20 w-20 shrink-0 items-center justify-center rounded-full border bg-surface2 text-5xl " + (ativo ? "relative border-gold/40 pulse-glow" : "border-border")
  }, ativo && /*#__PURE__*/React.createElement("span", {
    className: "chama-brilho"
  }), /*#__PURE__*/React.createElement("span", {
    className: ativo ? "chama-anim relative" : "relative"
  }, ativo ? "🔥" : "💤")));
}

/* card de ação rápida no topo do Dashboard: mostra o treino planejado
   pra hoje (grupos musculares + qtd de exercícios) com botão pra ir
   direto pra Planos de Treino, ou o estado de descanso/já concluído */
function CardTreinoHoje({
  planos,
  sessoes,
  irPara
}) {
  const diaHoje = useMemo(() => {
    const diaJs = new Date().getDay(); // 0 = domingo
    return diaJs === 0 ? "Domingo" : DIAS_SEMANA[diaJs - 1];
  }, []);
  const blocosHoje = (planos[diaHoje] || []).filter(b => b.exercicios.length > 0);
  const gruposHoje = [...new Set(blocosHoje.map(b => b.grupo))];
  const totalExHoje = blocosHoje.reduce((acc, b) => acc + b.exercicios.length, 0);
  const treinouHoje = useMemo(() => {
    const hojeStr = new Date().toDateString();
    return sessoes.some(s => new Date(s.data).toDateString() === hojeStr);
  }, [sessoes]);
  if (treinouHoje) {
    return /*#__PURE__*/React.createElement("div", {
      className: "card fade-up flex items-center gap-4 border-green-600/30 p-5"
    }, /*#__PURE__*/React.createElement("span", {
      className: "flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface2 text-2xl"
    }, "\u2705"), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-col gap-0.5"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-eyebrow text-green-400"
    }, "Treino de hoje"), /*#__PURE__*/React.createElement("span", {
      className: "text-sm font-medium text-text"
    }, "Treino de hoje conclu\xEDdo. Bom trabalho!")));
  }
  if (gruposHoje.length === 0) {
    return /*#__PURE__*/React.createElement("div", {
      className: "card fade-up flex items-center gap-4 p-5"
    }, /*#__PURE__*/React.createElement("span", {
      className: "flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface2 text-2xl"
    }, "\uD83D\uDCA4"), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-1 flex-col gap-0.5"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-eyebrow"
    }, "Treino de hoje"), /*#__PURE__*/React.createElement("span", {
      className: "text-sm font-medium text-text"
    }, "Nenhum treino planejado pra hoje (", diaHoje, ").")), /*#__PURE__*/React.createElement("button", {
      onClick: () => irPara("planos"),
      className: "shrink-0 rounded-lg border border-border px-4 py-2 text-sm font-medium text-text transition-colors hover:border-red hover:text-red"
    }, "Ver planos"));
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex items-center gap-4 border-red/30 p-5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface2 text-2xl"
  }, "\uD83C\uDFCB"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-1 flex-col gap-0.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow text-red"
  }, "Treino de hoje \xB7 ", diaHoje), /*#__PURE__*/React.createElement("span", {
    className: "text-sm font-medium text-text"
  }, gruposHoje.join(" + "), " \xB7 ", totalExHoje, " exerc\xEDcio", totalExHoje === 1 ? "" : "s")), /*#__PURE__*/React.createElement("button", {
    onClick: () => irPara("planos"),
    className: "shrink-0 rounded-lg bg-red px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
  }, "Come\xE7ar"));
}

/* card com a conquista mais próxima de ser desbloqueada, pra reforçar
   o hábito direto no Dashboard sem precisar entrar em Conquistas */
function CardProximaConquista({
  sessoes,
  irPara
}) {
  const stats = useMemo(() => calcularStatsSessoes(sessoes), [sessoes]);
  const {
    proxima,
    desbloqueadas,
    total
  } = useMemo(() => {
    const todosItens = CONQUISTAS_CONFIG.flatMap(g => g.itens);
    const comProgresso = todosItens.map(item => ({
      item,
      valorAtual: stats[item.campo] || 0,
      progresso: Math.min(100, (stats[item.campo] || 0) / item.meta * 100)
    }));
    const pendentes = comProgresso.filter(x => x.progresso < 100).sort((a, b) => b.progresso - a.progresso);
    return {
      proxima: pendentes[0] || null,
      desbloqueadas: comProgresso.filter(x => x.progresso >= 100).length,
      total: todosItens.length
    };
  }, [stats]);
  return /*#__PURE__*/React.createElement("div", {
    className: "card fade-up flex flex-col gap-3 p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Conquistas"), /*#__PURE__*/React.createElement("button", {
    onClick: () => irPara("conquistas"),
    className: "text-xs font-medium text-textFaint transition-colors hover:text-red"
  }, "Ver todas (", desbloqueadas, "/", total, ") \u2192")), proxima ? /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface2 text-xl opacity-80"
  }, proxima.item.icon), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-1 flex-col gap-1.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-baseline justify-between"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-sm font-medium text-text"
  }, proxima.item.titulo), /*#__PURE__*/React.createElement("span", {
    className: "tabular text-xs text-textFaint"
  }, Math.min(proxima.valorAtual, proxima.item.meta), " / ", proxima.item.meta, " ", proxima.item.unidade)), /*#__PURE__*/React.createElement("div", {
    className: "h-1.5 w-full overflow-hidden rounded-full bg-bg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-full rounded-full bg-gold transition-all",
    style: {
      width: proxima.progresso + "%"
    }
  })))) : /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, "Todas as conquistas desbloqueadas. Voc\xEA \xE9 uma lenda do Coliseu! \uD83D\uDC51"));
}

/* formata a variação percentual ou absoluta de uma métrica em relação
   aos 7 dias anteriores, pra dar contexto de progresso nos StatCards */
function formatarDeltaPct(atual, anterior) {
  if (!anterior) return undefined;
  const diff = Math.round((atual - anterior) / anterior * 100);
  if (diff === 0) return "igual à semana passada";
  return (diff > 0 ? "▲ +" : "▼ ") + diff + "% vs. semana passada";
}
function formatarDeltaDias(atual, anterior) {
  if (anterior == null) return undefined;
  const diff = atual - anterior;
  if (diff === 0) return "igual à semana passada";
  return (diff > 0 ? "▲ +" : "▼ ") + diff + " vs. semana passada";
}

/* saudação que varia pelo horário do dia, pra dar uma cara mais viva ao topo do Dashboard */
function saudacaoPorHorario() {
  const hora = new Date().getHours();
  if (hora < 5) return "Boa madrugada";
  if (hora < 12) return "Bom dia";
  if (hora < 18) return "Boa tarde";
  return "Boa noite";
}
function Dashboard({
  irPara
}) {
  const {
    unidadePeso
  } = useConfig();
  const [perfil] = useLocalStorage("perfil", {});
  const [sessoes] = useLocalStorage("treinos-log", []);
  const [diasSelecionados] = useLocalStorage("dias-selecionados", []);
  const [planos] = useLocalStorage("planos", {});
  const pesoKg = parseFloat(perfil.peso);
  const alturaCm = parseFloat(perfil.altura);
  const imc = calcularIMC(pesoKg, alturaCm);
  const pesoIdeal = calcularPesoIdeal(alturaCm, perfil.sexo);
  const nivelInfo = useMemo(() => calcularNivelXP(calcularXP(calcularStatsSessoes(sessoes))), [sessoes]);
  const streak = useMemo(() => calcularStreak(sessoes, diasSelecionados), [sessoes, diasSelecionados]);
  const agora = Date.now();
  const seteDiasAtras = agora - 7 * 24 * 60 * 60 * 1000;
  const catorzeDiasAtras = agora - 14 * 24 * 60 * 60 * 1000;
  const sessoesSemana = sessoes.filter(s => s.data >= seteDiasAtras);
  const sessoesSemanaAnterior = sessoes.filter(s => s.data >= catorzeDiasAtras && s.data < seteDiasAtras);
  const diasTreinados = new Set(sessoesSemana.map(s => new Date(s.data).toDateString())).size;
  const diasTreinadosAnterior = new Set(sessoesSemanaAnterior.map(s => new Date(s.data).toDateString())).size;
  const totalExercicios = sessoesSemana.reduce((acc, s) => acc + (s.exercicios?.length ?? 0), 0);
  const seriesExecutadas = sessoesSemana.reduce((acc, s) => acc + (s.seriesConcluidas ?? 0), 0);
  const cargaTotal = sessoesSemana.reduce((acc, s) => acc + (s.cargaTotal ?? 0), 0);
  const cargaTotalAnterior = sessoesSemanaAnterior.reduce((acc, s) => acc + (s.cargaTotal ?? 0), 0);
  const caloriasSemana = sessoesSemana.reduce((acc, s) => acc + (s.calorias ?? 0), 0);
  const caloriasSemanaAnterior = sessoesSemanaAnterior.reduce((acc, s) => acc + (s.calorias ?? 0), 0);
  const maiorCarga = sessoesSemana.reduce((max, s) => Math.max(max, s.maiorCarga ?? 0), 0);
  const semDados = sessoes.length === 0;
  const mensagemContexto = useMemo(() => {
    if (semDados) return "Monte seu plano semanal para começar a ver estatísticas aqui.";
    if (streak >= 2) return `Você está numa sequência de ${streak} dias treinando. Continue assim!`;
    if (diasTreinados === 0) return "Nenhum treino registrado essa semana ainda — bora começar?";
    return "Resumo da sua semana de treino.";
  }, [semDados, streak, diasTreinados]);

  /* mini-gráfico do Dashboard: carga movimentada por dia, últimos 30 dias
     (reaproveita o mesmo componente BarraEvolucao usado em Estatísticas) */
  const trintaDiasAtras = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const formatarDiaCurto = ts => new Date(ts).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit"
  });
  const dadosCargaMes = useMemo(() => {
    const porDia = {};
    sessoes.filter(s => s.data >= trintaDiasAtras).forEach(s => {
      const chave = new Date(s.data).toDateString();
      porDia[chave] = (porDia[chave] || 0) + (s.cargaTotal || 0);
    });
    return Object.entries(porDia).sort((a, b) => new Date(a[0]) - new Date(b[0])).map(([chave, valor]) => ({
      label: formatarDiaCurto(new Date(chave).getTime()),
      valor
    }));
  }, [sessoes]);
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-6 fade-up"
  }, /*#__PURE__*/React.createElement("header", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Dashboard"), /*#__PURE__*/React.createElement("h1", {
    className: "font-display text-2xl font-semibold"
  }, perfil.nome ? `${saudacaoPorHorario()}, ${perfil.nome}` : "Visão geral"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, mensagemContexto)), !semDados && /*#__PURE__*/React.createElement(CardTreinoHoje, {
    planos: planos,
    sessoes: sessoes,
    irPara: irPara
  }), /*#__PURE__*/React.createElement(CardStreakHero, {
    streak: streak
  }), /*#__PURE__*/React.createElement("section", {
    className: "grid grid-cols-1 gap-3 sm:grid-cols-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sm:col-span-2"
  }, /*#__PURE__*/React.createElement(CardNivel, {
    nivelInfo: nivelInfo
  })), /*#__PURE__*/React.createElement(StatCard, {
    label: "Treinos realizados",
    value: sessoesSemana.length,
    unit: "/ semana",
    icon: "calendario"
  })), semDados && /*#__PURE__*/React.createElement(EstadoVazio, {
    icon: "bandeira",
    titulo: "Nenhum treino registrado ainda",
    descricao: "Monte seu plano semanal para come\xE7ar a ver estat\xEDsticas aqui.",
    acao: /*#__PURE__*/React.createElement("button", {
      onClick: () => irPara("planos"),
      className: "rounded-lg bg-red px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
    }, "Montar treino")
  }), /*#__PURE__*/React.createElement("section", {
    className: "flex flex-col gap-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow px-1"
  }, "Esta semana"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3 sm:grid-cols-3"
  }, /*#__PURE__*/React.createElement(StatCard, {
    label: "Dias treinados",
    value: diasTreinados,
    unit: "/ 7",
    icon: "check",
    accent: diasTreinados >= 7 ? "green" : undefined,
    hint: formatarDeltaDias(diasTreinados, sessoes.length > 0 ? diasTreinadosAnterior : null)
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "S\xE9ries executadas",
    value: seriesExecutadas,
    icon: "repetir"
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "Total de exerc\xEDcios",
    value: totalExercicios,
    icon: "halter"
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "Carga movimentada",
    value: exibirPeso(cargaTotal, unidadePeso, 0),
    unit: rotuloPeso(unidadePeso),
    icon: "carga",
    hint: formatarDeltaPct(cargaTotal, cargaTotalAnterior)
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "Calorias gastas",
    value: caloriasSemana,
    unit: "kcal",
    icon: "fogo",
    hint: formatarDeltaPct(caloriasSemana, caloriasSemanaAnterior)
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "Maior carga",
    value: exibirPeso(maiorCarga, unidadePeso, 0),
    unit: rotuloPeso(unidadePeso),
    icon: "trof\xE9u",
    accent: "gold"
  }))), !semDados && /*#__PURE__*/React.createElement("button", {
    onClick: () => exportarResumoImagem({
      periodoLabel: "últimos 7 dias",
      resumo: {
        totalTreinos: sessoesSemana.length,
        totalCarga: cargaTotal,
        totalCalorias: caloriasSemana,
        totalSeries: seriesExecutadas
      }
    }),
    className: "self-start rounded-lg border border-red/60 px-4 py-2.5 text-sm font-medium text-red transition-colors hover:bg-red/10 active:scale-95"
  }, "\uD83D\uDCE4 Compartilhar resumo da semana"), !semDados && /*#__PURE__*/React.createElement("section", {
    className: "grid grid-cols-1 gap-3 sm:grid-cols-2"
  }, /*#__PURE__*/React.createElement(CardProximaConquista, {
    sessoes: sessoes,
    irPara: irPara
  }), dadosCargaMes.length > 1 && /*#__PURE__*/React.createElement(BarraEvolucao, {
    titulo: "Evolu\xE7\xE3o da carga",
    subtitulo: "Carga total movimentada por dia treinado (\xFAltimos 30 dias)",
    dados: dadosCargaMes,
    corBarra: "#e0a530"
  })), /*#__PURE__*/React.createElement("section", {
    className: "flex flex-col gap-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow px-1"
  }, "Corpo"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3 sm:grid-cols-3"
  }, /*#__PURE__*/React.createElement(StatCard, {
    label: "IMC",
    value: imc ? imc.toFixed(1) : "—",
    hint: imc ? classificarIMC(imc) : "complete seu perfil",
    icon: "raio"
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "Peso atual",
    value: perfil.peso ? exibirPeso(perfil.peso, unidadePeso) : "—",
    unit: perfil.peso ? rotuloPeso(unidadePeso) : "",
    icon: "balanca"
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "Peso ideal",
    value: pesoIdeal ? exibirPeso(pesoIdeal, unidadePeso) : "—",
    unit: pesoIdeal ? rotuloPeso(unidadePeso) : "",
    icon: "balanca"
  }))));
}

/* ---------- Biblioteca de exercícios ---------- */
function CardBibliotecaExercicio({
  nome,
  grupo
}) {
  const [aberto, setAberto] = useState(false);
  const info = useMemo(() => gerarDescricaoExercicio(nome, grupo), [nome, grupo]);
  return /*#__PURE__*/React.createElement("div", {
    className: "fade-up flex flex-col gap-0 overflow-hidden rounded-lg border border-border bg-surface2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setAberto(v => !v),
    className: "flex w-full items-center justify-between gap-3 p-3 text-left"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3 min-w-0"
  }, /*#__PURE__*/React.createElement("span", {
    className: "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-sm"
  }, "\uD83C\uDFCB\uFE0F"), /*#__PURE__*/React.createElement("div", {
    className: "flex min-w-0 flex-col"
  }, /*#__PURE__*/React.createElement("span", {
    className: "truncate text-sm font-medium text-text"
  }, nome), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textFaint"
  }, grupo))), /*#__PURE__*/React.createElement("span", {
    className: "shrink-0 text-textFaint transition-transform " + (aberto ? "rotate-180" : "")
  }, "\u25BE")), aberto && /*#__PURE__*/React.createElement("div", {
    className: "fade-up flex flex-col gap-3 border-t border-borderSoft p-3 pt-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-semibold uppercase tracking-wide text-textFaint"
  }, "Como executar"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, info.execucao)), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-semibold uppercase tracking-wide text-textFaint"
  }, "Dica"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, "\uD83D\uDCA1 ", info.dica)), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-semibold uppercase tracking-wide text-textFaint"
  }, "Erro comum"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, "\u26A0 ", info.erro)), /*#__PURE__*/React.createElement("a", {
    href: linkVideoExercicio(nome),
    target: "_blank",
    rel: "noopener noreferrer",
    className: "mt-1 inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-red hover:text-red"
  }, "\u25B6 Ver v\xEDdeos de execu\xE7\xE3o")));
}
function Biblioteca() {
  const [busca, setBusca] = useState("");
  const [grupoAtivo, setGrupoAtivo] = useState("Todos");
  const listaExercicios = useMemo(() => {
    const todos = [];
    Object.entries(EXERCICIOS_POR_GRUPO).forEach(([grupo, exercicios]) => {
      exercicios.forEach(nome => todos.push({
        nome,
        grupo
      }));
    });
    return todos;
  }, []);
  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return listaExercicios.filter(ex => {
      const bateGrupo = grupoAtivo === "Todos" || ex.grupo === grupoAtivo;
      const bateBusca = !termo || ex.nome.toLowerCase().includes(termo);
      return bateGrupo && bateBusca;
    });
  }, [listaExercicios, busca, grupoAtivo]);
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-6 fade-up"
  }, /*#__PURE__*/React.createElement("header", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Biblioteca"), /*#__PURE__*/React.createElement("h1", {
    className: "font-display text-2xl font-semibold"
  }, "Biblioteca de Exerc\xEDcios"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, listaExercicios.length, " exerc\xEDcios com orienta\xE7\xE3o de execu\xE7\xE3o, dicas e erros comuns.")), /*#__PURE__*/React.createElement("section", {
    className: "card flex flex-col gap-4 p-5"
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Buscar exerc\xEDcio"
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: busca,
    onChange: e => setBusca(e.target.value),
    placeholder: "Ex: supino, agachamento, rosca..."
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setGrupoAtivo("Todos"),
    className: "rounded-full border px-3 py-1 text-xs font-medium transition-colors " + (grupoAtivo === "Todos" ? "border-red bg-red text-white" : "border-border text-textMuted hover:text-text")
  }, "Todos"), GRUPOS_MUSCULARES.map(g => /*#__PURE__*/React.createElement("button", {
    key: g,
    onClick: () => setGrupoAtivo(g),
    className: "rounded-full border px-3 py-1 text-xs font-medium transition-colors " + (grupoAtivo === g ? "border-red bg-red text-white" : "border-border text-textMuted hover:text-text")
  }, g)))), /*#__PURE__*/React.createElement("section", {
    className: "flex flex-col gap-2"
  }, filtrados.length === 0 ? /*#__PURE__*/React.createElement("p", {
    className: "pl-2 text-sm text-textMuted"
  }, "Nenhum exerc\xEDcio encontrado.") : /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 gap-2 sm:grid-cols-2"
  }, filtrados.map(ex => /*#__PURE__*/React.createElement(CardBibliotecaExercicio, {
    key: ex.grupo + ex.nome,
    nome: ex.nome,
    grupo: ex.grupo
  })))));
}

/* ---------- Conquistas ---------- */
/* ---------- Gamificação: XP, Nível e Streak ---------- */
function calcularStatsSessoes(sessoes) {
  const totalSessoes = sessoes.length;
  const totalSeries = sessoes.reduce((t, s) => t + (s.seriesConcluidas || 0), 0);
  const totalExercicios = sessoes.reduce((t, s) => t + (s.exercicios?.length || 0), 0);
  const totalCalorias = sessoes.reduce((t, s) => t + (s.calorias || 0), 0);
  const totalCarga = sessoes.reduce((t, s) => t + (s.cargaTotal || 0), 0);
  const maiorCargaGeral = sessoes.reduce((m, s) => Math.max(m, s.maiorCarga || 0), 0);
  const diasDistintos = new Set(sessoes.map(s => new Date(s.data).toDateString())).size;
  return {
    totalSessoes,
    totalSeries,
    totalExercicios,
    totalCalorias,
    totalCarga,
    maiorCargaGeral,
    diasDistintos
  };
}

/* XP: reaproveita as mesmas contagens usadas nas Conquistas, sem depender
   de nenhum dado novo — cada série, treino e exercício concluído soma pontos. */
function calcularXP(stats) {
  return Math.round(stats.totalSeries * 15 + stats.totalSessoes * 40 + stats.totalExercicios * 10);
}
const NIVEIS_TITULOS = [{
  minNivel: 1,
  titulo: "Recruta"
}, {
  minNivel: 3,
  titulo: "Aspirante"
}, {
  minNivel: 6,
  titulo: "Guerreiro"
}, {
  minNivel: 10,
  titulo: "Gladiador"
}, {
  minNivel: 15,
  titulo: "Campeão da Arena"
}, {
  minNivel: 20,
  titulo: "Centurião"
}, {
  minNivel: 27,
  titulo: "Herói do Coliseu"
}, {
  minNivel: 35,
  titulo: "Lenda do Coliseu"
}];
function tituloDoNivel(nivel) {
  let atual = NIVEIS_TITULOS[0].titulo;
  for (const faixa of NIVEIS_TITULOS) {
    if (nivel >= faixa.minNivel) atual = faixa.titulo;
  }
  return atual;
}

/* faixa/tier do anel da foto de perfil, de acordo com o nível:
   0-10 bronze · 11-20 prata · 21-30 ouro · 31+ diamante */
function tierDoNivel(nivel) {
  if (nivel >= 31) return {
    classe: "anel-diamante",
    label: "Diamante"
  };
  if (nivel >= 21) return {
    classe: "anel-ouro",
    label: "Ouro"
  };
  if (nivel >= 11) return {
    classe: "anel-prata",
    label: "Prata"
  };
  return {
    classe: "anel-bronze",
    label: "Bronze"
  };
}

/* custo em XP pra subir de um nível pro seguinte — cresce a cada nível */
function custoNivel(nivel) {
  return 150 + (nivel - 1) * 60;
}
function calcularNivelXP(xp) {
  let nivel = 1;
  let acumulado = 0;
  let custo = custoNivel(nivel);
  while (xp >= acumulado + custo) {
    acumulado += custo;
    nivel += 1;
    custo = custoNivel(nivel);
  }
  const xpNoNivel = xp - acumulado;
  const progresso = Math.min(100, Math.round(xpNoNivel / custo * 100));
  return {
    nivel,
    titulo: tituloDoNivel(nivel),
    xpNoNivel,
    xpParaProximoNivel: custo,
    progresso,
    xpTotal: xp
  };
}

/* sequência de dias treinados: conta pra trás a partir de hoje, considerando
   os dias planejados na semana (dias-selecionados). sem plano definido,
   qualquer dia com treino registrado conta. quebra no primeiro dia
   planejado que passou sem treino (hoje sempre recebe um passe, já que
   o dia ainda não acabou). */
function calcularStreak(sessoes, diasSelecionados) {
  const diasTreinados = new Set(sessoes.map(s => new Date(s.data).toDateString()));
  if (diasTreinados.size === 0) return 0;
  let streak = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const hojeStr = cursor.toDateString();
  for (let i = 0; i < 400; i++) {
    const diaLabel = DIAS_SEMANA[(cursor.getDay() + 6) % 7];
    const ehPlanejado = diasSelecionados.length === 0 || diasSelecionados.includes(diaLabel);
    const treinou = diasTreinados.has(cursor.toDateString());
    if (ehPlanejado) {
      if (treinou) {
        streak += 1;
      } else if (cursor.toDateString() !== hojeStr) {
        break;
      }
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
const CONQUISTAS_CONFIG = [
/* Metas calibradas assumindo um ritmo de ~3-4 treinos por semana (o mais comum
   entre quem treina com constância). Faixas-alvo de tempo até desbloquear:
     Fácil   → 15 dias a 1 mês  (exceto o "Primeiro Passo", que é imediato)
     Média   → 3 a 6 meses
     Difícil → 9 a 12 meses
   Os números por sessão usados como referência: ~15 séries, ~5 exercícios
   concluídos, ~700 kg de carga total e ~350 kcal por treino. */
{
  dificuldade: "Fácil",
  corTexto: "text-green-400",
  corBarra: "#22c55e",
  corBorda: "border-green-600/40",
  itens: [{
    id: "primeiro-treino",
    titulo: "Primeiro Passo",
    descricao: "Complete seu primeiro treino.",
    icon: "🥉",
    meta: 1,
    unidade: "treino",
    campo: "totalSessoes"
  }, {
    id: "vinte-series",
    titulo: "Esquentando",
    descricao: "Complete 150 séries no total.",
    icon: "🔥",
    meta: 150,
    unidade: "séries",
    campo: "totalSeries"
  }, {
    id: "cinco-dias",
    titulo: "Explorador",
    descricao: "Treine em 12 dias diferentes.",
    icon: "🗓️",
    meta: 12,
    unidade: "dias",
    campo: "diasDistintos"
  }, {
    id: "trezentas-kcal",
    titulo: "Primeira Queimada",
    descricao: "Queime 3.500 kcal acumuladas.",
    icon: "🥵",
    meta: 3500,
    unidade: "kcal",
    campo: "totalCalorias"
  }, {
    id: "trezentos-carga",
    titulo: "Primeira Carga",
    descricao: "Movimente 7.000 kg de carga acumulada.",
    icon: "📦",
    meta: 7000,
    unidade: "kg",
    campo: "totalCarga"
  }, {
    id: "cinco-exercicios",
    titulo: "Repertório",
    descricao: "Complete 50 exercícios no total.",
    icon: "📋",
    meta: 50,
    unidade: "exercícios",
    campo: "totalExercicios"
  }, {
    id: "ritmo-constante",
    titulo: "Ritmo Constante",
    descricao: "Complete 200 séries no total.",
    icon: "⚡",
    meta: 200,
    unidade: "séries",
    campo: "totalSeries"
  }, {
    id: "queima-reforcada",
    titulo: "Queima Reforçada",
    descricao: "Queime 4.500 kcal acumuladas.",
    icon: "🔆",
    meta: 4500,
    unidade: "kcal",
    campo: "totalCalorias"
  }, {
    id: "carga-extra",
    titulo: "Carga Extra",
    descricao: "Movimente 9.000 kg de carga acumulada.",
    icon: "🏗️",
    meta: 9000,
    unidade: "kg",
    campo: "totalCarga"
  }]
}, {
  dificuldade: "Média",
  corTexto: "text-amber-400",
  corBarra: "#f59e0b",
  corBorda: "border-amber-600/40",
  itens: [{
    id: "trinta-treinos",
    titulo: "Constância",
    descricao: "Complete 70 treinos no total.",
    icon: "💪",
    meta: 70,
    unidade: "treinos",
    campo: "totalSessoes"
  }, {
    id: "4000-kcal",
    titulo: "Suando a Camisa",
    descricao: "Queime 25.000 kcal acumuladas.",
    icon: "🌡️",
    meta: 25000,
    unidade: "kcal",
    campo: "totalCalorias"
  }, {
    id: "4000-carga",
    titulo: "Peso Pesado",
    descricao: "Movimente 50.000 kg de carga acumulada.",
    icon: "📈",
    meta: 50000,
    unidade: "kg",
    campo: "totalCarga"
  }, {
    id: "250-series",
    titulo: "Maratona de Séries",
    descricao: "Complete 1.000 séries no total.",
    icon: "🔁",
    meta: 1000,
    unidade: "séries",
    campo: "totalSeries"
  }, {
    id: "25-dias",
    titulo: "Frequência de Ferro",
    descricao: "Treine em 70 dias diferentes.",
    icon: "📆",
    meta: 70,
    unidade: "dias",
    campo: "diasDistintos"
  }, {
    id: "40-exercicios",
    titulo: "Colecionador",
    descricao: "Complete 350 exercícios no total.",
    icon: "🗂️",
    meta: 350,
    unidade: "exercícios",
    campo: "totalExercicios"
  }, {
    id: "disciplina-de-ferro",
    titulo: "Disciplina de Ferro",
    descricao: "Complete 90 treinos no total.",
    icon: "🛡️",
    meta: 90,
    unidade: "treinos",
    campo: "totalSessoes"
  }, {
    id: "presenca-constante",
    titulo: "Presença Constante",
    descricao: "Treine em 90 dias diferentes.",
    icon: "📅",
    meta: 90,
    unidade: "dias",
    campo: "diasDistintos"
  }, {
    id: "arsenal-ampliado",
    titulo: "Arsenal Ampliado",
    descricao: "Complete 450 exercícios no total.",
    icon: "🗃️",
    meta: 450,
    unidade: "exercícios",
    campo: "totalExercicios"
  }]
}, {
  dificuldade: "Difícil",
  corTexto: "text-red",
  corBarra: "#d60000",
  corBorda: "border-red/40",
  itens: [{
    id: "150-treinos",
    titulo: "Maratonista",
    descricao: "Complete 180 treinos no total.",
    icon: "🏅",
    meta: 180,
    unidade: "treinos",
    campo: "totalSessoes"
  }, {
    id: "15mil-carga",
    titulo: "Levantador de Ferro",
    descricao: "Movimente 130.000 kg de carga acumulada.",
    icon: "🏋️",
    meta: 130000,
    unidade: "kg",
    campo: "totalCarga"
  }, {
    id: "300-dias",
    titulo: "Lenda do Coliseu",
    descricao: "Treine em 180 dias diferentes.",
    icon: "👑",
    meta: 180,
    unidade: "dias",
    campo: "diasDistintos"
  }, {
    id: "15mil-kcal",
    titulo: "Fornalha Humana",
    descricao: "Queime 65.000 kcal acumuladas.",
    icon: "☄️",
    meta: 65000,
    unidade: "kcal",
    campo: "totalCalorias"
  }, {
    id: "180-recorde",
    titulo: "Recorde Pessoal",
    descricao: "Registre 200 kg na maior carga de um exercício.",
    icon: "🦾",
    meta: 200,
    unidade: "kg",
    campo: "maiorCargaGeral"
  }, {
    id: "100-exercicios",
    titulo: "Imparável",
    descricao: "Complete 900 exercícios no total.",
    icon: "🚀",
    meta: 900,
    unidade: "exercícios",
    campo: "totalExercicios"
  }, {
    id: "tita-de-ferro",
    titulo: "Titã de Ferro",
    descricao: "Movimente 170.000 kg de carga acumulada.",
    icon: "⚙️",
    meta: 170000,
    unidade: "kg",
    campo: "totalCarga"
  }, {
    id: "inferno-ardente",
    titulo: "Inferno Ardente",
    descricao: "Queime 85.000 kcal acumuladas.",
    icon: "🌋",
    meta: 85000,
    unidade: "kcal",
    campo: "totalCalorias"
  }, {
    id: "forca-suprema",
    titulo: "Força Suprema",
    descricao: "Registre 260 kg na maior carga de um exercício.",
    icon: "🦍",
    meta: 260,
    unidade: "kg",
    campo: "maiorCargaGeral"
  }]
}];
function CardConquista({
  item,
  valorAtual,
  corTexto,
  corBarra,
  corBorda
}) {
  const concluida = valorAtual >= item.meta;
  const progresso = Math.min(100, Math.round(valorAtual / item.meta * 100));
  return /*#__PURE__*/React.createElement("div", {
    className: "fade-up flex flex-col gap-3 rounded-lg border p-4 transition-colors " + (concluida ? corBorda + " bg-surface2" : "border-border bg-surface2/60")
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-start justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg " + (concluida ? "bg-bg" : "bg-bg opacity-40 grayscale")
  }, item.icon), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-sm font-medium text-text"
  }, item.titulo), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textFaint"
  }, item.descricao))), concluida && /*#__PURE__*/React.createElement("span", {
    className: "shrink-0 text-xs font-semibold " + corTexto
  }, "\u2713 conclu\xEDda")), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-1.5 w-full overflow-hidden rounded-full bg-bg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-full rounded-full transition-all",
    style: {
      width: progresso + "%",
      background: corBarra
    }
  })), /*#__PURE__*/React.createElement("span", {
    className: "tabular text-xs text-textFaint"
  }, Math.min(valorAtual, item.meta), " / ", item.meta, " ", item.unidade)));
}
function Conquistas() {
  const [sessoes] = useLocalStorage("treinos-log", []);
  const stats = useMemo(() => calcularStatsSessoes(sessoes), [sessoes]);
  const totalConquistas = CONQUISTAS_CONFIG.reduce((t, g) => t + g.itens.length, 0);
  const totalDesbloqueadas = CONQUISTAS_CONFIG.reduce((t, g) => t + g.itens.filter(item => stats[item.campo] >= item.meta).length, 0);
  return /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-6 fade-up"
  }, /*#__PURE__*/React.createElement("header", {
    className: "flex flex-col gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow"
  }, "Conquistas"), /*#__PURE__*/React.createElement("h1", {
    className: "font-display text-2xl font-semibold"
  }, "Suas metas no Smart Coliseu"), /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, totalDesbloqueadas, " de ", totalConquistas, " conquistas desbloqueadas.")), CONQUISTAS_CONFIG.map(grupo => /*#__PURE__*/React.createElement("section", {
    key: grupo.dificuldade,
    className: "flex flex-col gap-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-eyebrow px-1 " + grupo.corTexto
  }, grupo.dificuldade), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
  }, grupo.itens.map(item => /*#__PURE__*/React.createElement(CardConquista, {
    key: item.id,
    item: item,
    valorAtual: stats[item.campo],
    corTexto: grupo.corTexto,
    corBarra: grupo.corBarra,
    corBorda: grupo.corBorda
  }))))));
}

/* ---------- Shell / nav ---------- */
const NAV_ITEMS = [{
  id: "perfil",
  label: "Perfil",
  shortLabel: "Perfil",
  icon: "perfil"
}, {
  id: "dashboard",
  label: "Dashboard",
  shortLabel: "Início",
  icon: "dashboard"
}, {
  id: "planos",
  label: "Planos de Treino",
  shortLabel: "Treinos",
  icon: "planos"
}, {
  id: "personalizado",
  label: "Treino Personalizado",
  shortLabel: "Custom",
  icon: "personalizado"
}, {
  id: "estatisticas",
  label: "Estatísticas",
  shortLabel: "Stats",
  icon: "estatisticas"
}, {
  id: "biblioteca",
  label: "Biblioteca de Exercícios",
  shortLabel: "Biblioteca",
  icon: "biblioteca"
}, {
  id: "conquistas",
  label: "Conquistas",
  shortLabel: "Conquistas",
  icon: "conquistas"
}, {
  id: "configuracoes",
  label: "Configurações",
  shortLabel: "Ajustes",
  icon: "configuracoes"
}];
function NavItem({
  item,
  active,
  onClick,
  compact
}) {
  const isActive = active === item.id;
  if (compact) {
    return /*#__PURE__*/React.createElement("button", {
      onClick: () => onClick(item.id),
      "aria-label": item.label,
      className: "flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl py-1.5 transition-colors " + (isActive ? "text-red" : "text-textFaint")
    }, /*#__PURE__*/React.createElement("span", {
      className: "flex h-8 w-8 items-center justify-center rounded-full leading-none transition-colors " + (isActive ? "bg-red/15" : "")
    }, /*#__PURE__*/React.createElement(Icon, {
      name: item.icon,
      size: 18
    })), /*#__PURE__*/React.createElement("span", {
      className: "max-w-full truncate px-0.5 text-[0.6rem] font-medium leading-none"
    }, item.shortLabel || item.label));
  }
  return /*#__PURE__*/React.createElement("button", {
    onClick: () => onClick(item.id),
    className: "group flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm transition-colors text-left w-full " + (isActive ? "border-border bg-surface2 text-text" : "text-textMuted hover:text-text")
  }, /*#__PURE__*/React.createElement("span", {
    className: isActive ? "text-red" : "text-textFaint"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: item.icon,
    size: 18
  })), /*#__PURE__*/React.createElement("span", {
    className: "font-medium"
  }, item.label));
}

/* ---------- Cartão de perfil fixo na sidebar ----------
   Mostra foto (ou iniciais), nome e nível/tier logo abaixo do logo,
   sempre visível em qualquer tela — clicável, leva pra tela de Perfil. */
function CartaoPerfilSidebar({
  irPara
}) {
  const [perfil] = useLocalStorage("perfil", PERFIL_INICIAL);
  const [sessoes] = useLocalStorage("treinos-log", []);
  const nivelInfo = useMemo(() => calcularNivelXP(calcularXP(calcularStatsSessoes(sessoes))), [sessoes]);
  const tier = tierDoNivel(nivelInfo.nivel);
  const iniciais = (perfil.nome || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => irPara && irPara("perfil"),
    className: "mb-4 flex items-center gap-3 rounded-xl border border-border bg-surface2 px-3 py-3 text-left transition-colors hover:border-red/40"
  }, /*#__PURE__*/React.createElement("span", {
    className: "anel-nivel " + tier.classe + " shrink-0"
  }, /*#__PURE__*/React.createElement("span", {
    className: "flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border-2 border-bg bg-surface"
  }, perfil.foto ? /*#__PURE__*/React.createElement("img", {
    src: perfil.foto,
    alt: "",
    className: "h-full w-full object-cover"
  }) : /*#__PURE__*/React.createElement("span", {
    className: "font-display text-xs font-semibold text-textMuted"
  }, iniciais))), /*#__PURE__*/React.createElement("div", {
    className: "flex min-w-0 flex-col leading-tight"
  }, /*#__PURE__*/React.createElement("span", {
    className: "truncate text-sm font-semibold text-text"
  }, perfil.nome || "Seu perfil"), /*#__PURE__*/React.createElement("span", {
    className: "text-[0.65rem] text-textFaint"
  }, "N\xEDvel ", nivelInfo.nivel, " \xB7 ", tier.label)));
}
function Shell({
  page,
  setPage,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "min-h-screen bg-bg text-text"
  }, /*#__PURE__*/React.createElement("aside", {
    className: "fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-borderSoft bg-surface px-4 py-6 md:flex"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-6 flex items-center gap-2 px-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface2"
  }, /*#__PURE__*/React.createElement("img", {
    src: LOGO_SRC,
    alt: "Smart Coliseu",
    className: "h-full w-full object-cover"
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col leading-tight"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-display text-sm font-semibold"
  }, "Smart Coliseu"), /*#__PURE__*/React.createElement("span", {
    className: "text-[0.65rem] text-textFaint"
  }, "treino sob controle"))), /*#__PURE__*/React.createElement(CartaoPerfilSidebar, {
    irPara: setPage
  }), /*#__PURE__*/React.createElement("nav", {
    className: "flex flex-1 flex-col gap-1"
  }, NAV_ITEMS.map(item => /*#__PURE__*/React.createElement(NavItem, {
    key: item.id,
    item: item,
    active: page,
    onClick: setPage
  }))), /*#__PURE__*/React.createElement("div", {
    className: "text-eyebrow px-2"
  }, "v1.0 \xB7 dados salvos localmente")), /*#__PURE__*/React.createElement("main", {
    className: "min-h-screen px-4 pb-28 pt-6 md:ml-64 md:px-8 md:pb-8 md:pt-8"
  }, children), /*#__PURE__*/React.createElement("nav", {
    className: "glass fixed inset-x-0 bottom-0 z-40 flex items-stretch gap-0.5 border-t border-borderSoft px-1.5 pt-1.5 md:hidden",
    style: {
      paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))"
    }
  }, NAV_ITEMS.map(item => /*#__PURE__*/React.createElement(NavItem, {
    key: item.id,
    item: item,
    active: page,
    onClick: setPage,
    compact: true
  }))));
}

/* ---------- Watcher global de conquistas: roda em qualquer página, não só
   na tela "Conquistas", e dispara o card de celebração assim que uma meta
   é atingida pela primeira vez. */
function ConquistaWatcher() {
  const [sessoes] = useLocalStorage("treinos-log", []);
  const [vistas, setVistas] = useLocalStorage("conquistas-vistas", null); // null = ainda não inicializado
  const [fila, setFila] = useState([]);
  const stats = useMemo(() => calcularStatsSessoes(sessoes), [sessoes]);
  useEffect(() => {
    const todosItens = CONQUISTAS_CONFIG.flatMap(g => g.itens);
    const desbloqueadasAgora = todosItens.filter(item => stats[item.campo] >= item.meta).map(item => item.id);
    if (vistas === null) {
      /* primeira carga do app (ou dados antigos): marca o que já está
         desbloqueado como "visto" sem celebrar, só celebra daqui pra frente */
      setVistas(desbloqueadasAgora);
      return;
    }
    const novas = desbloqueadasAgora.filter(id => !vistas.includes(id));
    if (novas.length > 0) {
      setVistas(prev => [...(prev || []), ...novas]);
      setFila(prev => [...prev, ...todosItens.filter(item => novas.includes(item.id))]);
    }
  }, [stats.totalSessoes, stats.totalSeries, stats.totalExercicios, stats.totalCalorias, stats.totalCarga, stats.maiorCargaGeral, stats.diasDistintos]);
  if (fila.length === 0) return null;
  const atual = fila[0];
  return /*#__PURE__*/React.createElement(CelebracaoOverlay, {
    tipo: "conquista",
    icon: atual.icon,
    titulo: atual.titulo,
    subtitulo: atual.descricao,
    onFechar: () => setFila(prev => prev.slice(1))
  });
}

/* ---------- Lembrete de treino do dia ----------
   Funciona enquanto o app está aberto no navegador (sem servidor de push,
   já que o app não tem backend) — verifica a cada minuto se hoje é dia de
   treino planejado, se o horário do lembrete já passou, se ainda não foi
   registrado nenhum treino hoje, e dispara uma notificação do navegador
   uma única vez por dia. */
const LEMBRETE_PADRAO = {
  ativo: false,
  horario: "18:00"
};
function diaLabelDeHoje() {
  const diaJs = new Date().getDay();
  return diaJs === 0 ? "Domingo" : DIAS_SEMANA[diaJs - 1];
}
function LembreteTreinoWatcher() {
  const [lembrete] = useLocalStorage("lembrete-treino", LEMBRETE_PADRAO);
  const [diasSelecionados] = useLocalStorage("dias-selecionados", []);
  const [planos] = useLocalStorage("planos", {});
  const [sessoes] = useLocalStorage("treinos-log", []);
  const [ultimoAviso, setUltimoAviso] = useLocalStorage("lembrete-ultimo-aviso", null);
  useEffect(() => {
    if (!lembrete.ativo || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const verificar = () => {
      const hojeStr = new Date().toDateString();
      if (ultimoAviso === hojeStr) return;
      const diaHoje = diaLabelDeHoje();
      const ehDiaDeTreino = diasSelecionados.length === 0 ? (planos[diaHoje] || []).some(b => b.exercicios.length > 0) : diasSelecionados.includes(diaHoje) && (planos[diaHoje] || []).some(b => b.exercicios.length > 0);
      if (!ehDiaDeTreino) return;
      const jaTreinouHoje = sessoes.some(s => new Date(s.data).toDateString() === hojeStr);
      if (jaTreinouHoje) return;
      const [h, m] = (lembrete.horario || "18:00").split(":").map(Number);
      const agora = new Date();
      const alvo = new Date();
      alvo.setHours(h || 18, m || 0, 0, 0);
      if (agora < alvo) return;
      new Notification("Hora do treino 💪", {
        body: "Você tem treino planejado hoje e ainda não registrou nada. Bora?",
        icon: LOGO_SRC
      });
      setUltimoAviso(hojeStr);
    };
    verificar();
    const intervalo = setInterval(verificar, 60 * 1000);
    return () => clearInterval(intervalo);
  }, [lembrete, diasSelecionados, planos, sessoes, ultimoAviso]);
  return null;
}

/* ---------- App ---------- */
/* ---------- acesso: login, cadastro e assinatura ---------- */

/* Bloco de conta dentro de Configurações: quem está logado, quanto falta pra
   vencer e como sair. Busca sozinho porque Configurações pode ser aberta
   muito depois do login, quando a situação já mudou. */
function ResumoDaConta() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(false);
  useEffect(() => {
    let ativo = true;
    Promise.all([nuvem.pedir("/auth/me", {
      method: "GET"
    }), nuvem.pedir("/pagamento/status", {
      method: "GET"
    })]).then(([me, status]) => {
      if (ativo) setDados({
        aluno: me.aluno,
        status
      });
    }).catch(() => {
      if (ativo) setErro(true);
    });
    return () => {
      ativo = false;
    };
  }, []);
  if (erro) {
    return /*#__PURE__*/React.createElement("p", {
      className: "pl-2 text-xs text-textMuted"
    }, "Sem conex\xE3o \u2014 n\xE3o deu pra carregar os dados da conta agora.");
  }
  if (!dados) {
    return /*#__PURE__*/React.createElement("p", {
      className: "pl-2 text-xs text-textFaint"
    }, "Carregando\u2026");
  }
  const {
    aluno,
    status
  } = dados;
  const validade = status.vitalicio ? "Acesso vitalício" : status.emTrial ? `Teste grátis — ${status.diasRestantes} dia(s) restante(s)` : status.assinaturaValida ? `Assinatura ativa — renova em ${status.diasRestantes} dia(s)` : "Acesso vencido";
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-0.5 rounded-lg border border-border bg-surface2 p-3"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-sm font-medium text-text"
  }, aluno.nome), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-textMuted"
  }, aluno.email), /*#__PURE__*/React.createElement("span", {
    className: "mt-1 text-xs font-medium text-red"
  }, validade)), /*#__PURE__*/React.createElement(LinhaConfig, {
    titulo: "Sair da conta",
    descricao: "Os dados salvos neste aparelho s\xE3o apagados. Eles continuam na sua conta e voltam no pr\xF3ximo login."
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => nuvem.sair(),
    className: "rounded-lg border border-border px-4 py-2 text-sm font-medium text-text transition-colors hover:border-red hover:text-red"
  }, "Sair")));
}
function CampoAcesso({
  rotulo,
  ...props
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: "flex flex-col gap-1.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-medium uppercase tracking-wide text-textFaint"
  }, rotulo), /*#__PURE__*/React.createElement("input", _extends({}, props, {
    className: "rounded-lg border border-border bg-surface2 px-3 py-2.5 text-sm text-text outline-none transition-colors placeholder:text-textFaint focus:border-red"
  })));
}
function TelaAcesso({
  aoEntrar
}) {
  const [modo, setModo] = useState("entrar"); // "entrar" | "criar"
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);
  const criando = modo === "criar";
  async function enviar(e) {
    e.preventDefault();
    setErro("");
    setEnviando(true);
    try {
      const aluno = criando ? await nuvem.cadastrar(nome.trim(), email.trim(), senha) : await nuvem.entrar(email.trim(), senha);
      aoEntrar(aluno);
    } catch (err) {
      setErro(err.message || "Não consegui conectar. Verifique sua internet.");
      setEnviando(false);
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "flex min-h-screen items-center justify-center bg-bg p-5 text-text"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-sm"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-7 text-center"
  }, /*#__PURE__*/React.createElement("h1", {
    className: "font-display text-2xl font-bold tracking-tight"
  }, "Smart ", /*#__PURE__*/React.createElement("span", {
    className: "text-red"
  }, "Coliseu")), /*#__PURE__*/React.createElement("p", {
    className: "mt-1.5 text-sm text-textMuted"
  }, criando ? "Crie sua conta e comece com 7 dias grátis." : "Entre para acessar seus treinos.")), /*#__PURE__*/React.createElement("form", {
    onSubmit: enviar,
    className: "flex flex-col gap-3.5 rounded-2xl border border-border bg-surface p-5"
  }, criando && /*#__PURE__*/React.createElement(CampoAcesso, {
    rotulo: "Nome",
    type: "text",
    value: nome,
    required: true,
    autoComplete: "name",
    placeholder: "Seu nome",
    onChange: e => setNome(e.target.value)
  }), /*#__PURE__*/React.createElement(CampoAcesso, {
    rotulo: "E-mail",
    type: "email",
    value: email,
    required: true,
    autoComplete: "email",
    placeholder: "voce@email.com",
    onChange: e => setEmail(e.target.value)
  }), /*#__PURE__*/React.createElement(CampoAcesso, {
    rotulo: "Senha",
    type: "password",
    value: senha,
    required: true,
    minLength: 6,
    autoComplete: criando ? "new-password" : "current-password",
    placeholder: criando ? "Mínimo 6 caracteres" : "Sua senha",
    onChange: e => setSenha(e.target.value)
  }), erro && /*#__PURE__*/React.createElement("p", {
    className: "rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-xs text-red"
  }, erro), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    disabled: enviando,
    className: "mt-1 rounded-lg bg-red px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
  }, enviando ? "Aguarde..." : criando ? "Criar conta" : "Entrar"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      setModo(criando ? "entrar" : "criar");
      setErro("");
    },
    className: "text-xs text-textMuted underline-offset-2 transition-colors hover:text-text hover:underline"
  }, criando ? "Já tenho conta — entrar" : "Não tenho conta — criar agora")), /*#__PURE__*/React.createElement("p", {
    className: "mt-4 text-center text-xs text-textFaint"
  }, "Seus treinos ficam salvos na sua conta e aparecem em todos os seus aparelhos.")));
}
function TelaAssinatura({
  situacao,
  aoSair,
  aoRevalidar
}) {
  const [erro, setErro] = useState("");
  const [indo, setIndo] = useState(false);
  async function assinar() {
    setErro("");
    setIndo(true);
    try {
      const r = await nuvem.pedir("/pagamento/gerar-cobranca", {
        method: "POST"
      });
      window.location.href = r.url;
    } catch (e) {
      setErro(e.message || "Não consegui gerar o pagamento. Tente de novo.");
      setIndo(false);
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "flex min-h-screen items-center justify-center bg-bg p-5 text-text"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-sm text-center"
  }, /*#__PURE__*/React.createElement("h1", {
    className: "font-display text-2xl font-bold tracking-tight"
  }, "Smart ", /*#__PURE__*/React.createElement("span", {
    className: "text-red"
  }, "Coliseu")), /*#__PURE__*/React.createElement("div", {
    className: "mt-6 rounded-2xl border border-border bg-surface p-6"
  }, /*#__PURE__*/React.createElement("p", {
    className: "text-sm text-textMuted"
  }, situacao && situacao.emTrial === false && situacao.expiraEm ? "Seu acesso venceu." : "Seus 7 dias grátis terminaram."), /*#__PURE__*/React.createElement("p", {
    className: "mt-4 font-display text-3xl font-bold"
  }, situacao && situacao.precoTexto || "R$ 9,90", /*#__PURE__*/React.createElement("span", {
    className: "text-base font-medium text-textMuted"
  }, " /m\xEAs")), /*#__PURE__*/React.createElement("p", {
    className: "mt-1.5 text-xs text-textFaint"
  }, "Renove quando quiser. Seus treinos continuam salvos."), erro && /*#__PURE__*/React.createElement("p", {
    className: "mt-4 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-xs text-red"
  }, erro), /*#__PURE__*/React.createElement("button", {
    onClick: assinar,
    disabled: indo,
    className: "mt-5 w-full rounded-lg bg-red px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
  }, indo ? "Abrindo pagamento..." : "Assinar agora"), /*#__PURE__*/React.createElement("button", {
    onClick: aoRevalidar,
    className: "mt-3 text-xs text-textMuted underline-offset-2 transition-colors hover:text-text hover:underline"
  }, "J\xE1 paguei \u2014 verificar de novo")), /*#__PURE__*/React.createElement("button", {
    onClick: aoSair,
    className: "mt-5 text-xs text-textFaint underline-offset-2 transition-colors hover:text-textMuted hover:underline"
  }, "Sair da conta")));
}

/* Decide o que mostrar: login, paywall ou o app. Fica por fora do App pra que
   nenhuma tela do app chegue a montar sem acesso válido. */
function PortaoDeAcesso({
  children
}) {
  const [estado, setEstado] = useState(nuvem.logado() ? "checando" : "deslogado");
  const [situacao, setSituacao] = useState(null);
  async function conferir() {
    if (!nuvem.logado()) {
      setEstado("deslogado");
      return;
    }
    setEstado("checando");
    try {
      const s = await nuvem.pedir("/pagamento/status", {
        method: "GET"
      });
      setSituacao(s);
      setEstado(s.liberado ? "liberado" : "bloqueado");
      if (s.liberado) nuvem.conectar();
    } catch (e) {
      if (e.status === 401) {
        // token vencido ou conta apagada: volta pro login
        try {
          window.localStorage.removeItem(CHAVE_TOKEN);
        } catch (er) {}
        nuvem.token = null;
        setEstado("deslogado");
        return;
      }
      /* Sem internet não dá pra confirmar a assinatura — e trancar quem já
         pagou por causa de um metrô sem sinal seria pior que deixar entrar.
         Os dados estão no localStorage, então o app abre offline. */
      setEstado("liberado");
    }
  }
  useEffect(() => {
    conferir();
  }, []);
  if (estado === "checando") {
    return /*#__PURE__*/React.createElement("div", {
      className: "flex min-h-screen items-center justify-center bg-bg"
    }, /*#__PURE__*/React.createElement("div", {
      className: "h-8 w-8 animate-spin rounded-full border-2 border-border border-t-red"
    }));
  }
  if (estado === "deslogado") return /*#__PURE__*/React.createElement(TelaAcesso, {
    aoEntrar: conferir
  });
  if (estado === "bloqueado") {
    return /*#__PURE__*/React.createElement(TelaAssinatura, {
      situacao: situacao,
      aoSair: () => nuvem.sair(),
      aoRevalidar: conferir
    });
  }
  return children;
}
function App() {
  const [carregando, setCarregando] = useState(true);
  const [page, setPage] = useState("perfil");
  const [config, setConfig] = useLocalStorage("configuracoes", CONFIG_PADRAO);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", config.tema === "light" ? "light" : "dark");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", config.tema === "light" ? "#f6f6f8" : "#050505");
  }, [config.tema]);
  const setTema = tema => setConfig(c => ({
    ...c,
    tema
  }));
  const setUnidadePeso = unidadePeso => setConfig(c => ({
    ...c,
    unidadePeso
  }));
  if (carregando) return /*#__PURE__*/React.createElement(LoadingScreen, {
    onDone: () => setCarregando(false)
  });
  return /*#__PURE__*/React.createElement(ConfigContext.Provider, {
    value: {
      ...config,
      setTema,
      setUnidadePeso
    }
  }, /*#__PURE__*/React.createElement(ConquistaWatcher, null), /*#__PURE__*/React.createElement(LembreteTreinoWatcher, null), /*#__PURE__*/React.createElement(Shell, {
    page: page,
    setPage: setPage
  }, page === "dashboard" && /*#__PURE__*/React.createElement(Dashboard, {
    irPara: setPage
  }), page === "planos" && /*#__PURE__*/React.createElement(PlanosTreino, null), page === "personalizado" && /*#__PURE__*/React.createElement(TreinoPersonalizado, null), page === "biblioteca" && /*#__PURE__*/React.createElement(Biblioteca, null), page === "conquistas" && /*#__PURE__*/React.createElement(Conquistas, null), page === "estatisticas" && /*#__PURE__*/React.createElement(Estatisticas, null), page === "perfil" && /*#__PURE__*/React.createElement(Perfil, {
    irPara: setPage
  }), page === "configuracoes" && /*#__PURE__*/React.createElement(Configuracoes, null)));
}

/* pega qualquer erro de runtime que quebraria a montagem do app e mostra uma
   tela de erro legível, em vez de deixar a pessoa numa tela preta sem
   nenhuma pista do que aconteceu. */
class ErroFatal extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      erro: null
    };
  }
  static getDerivedStateFromError(erro) {
    return {
      erro
    };
  }
  componentDidCatch(erro, info) {
    console.error("Erro fatal no Smart Coliseu:", erro, info);
  }
  render() {
    if (this.state.erro) {
      return /*#__PURE__*/React.createElement("div", {
        className: "flex min-h-screen flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-text"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-4xl"
      }, "\u26A0\uFE0F"), /*#__PURE__*/React.createElement("h2", {
        className: "font-display text-lg font-semibold"
      }, "Algo deu errado"), /*#__PURE__*/React.createElement("p", {
        className: "max-w-sm text-sm text-textMuted"
      }, "O app encontrou um erro inesperado e n\xE3o conseguiu carregar essa tela. Tente recarregar a p\xE1gina."), /*#__PURE__*/React.createElement("p", {
        className: "max-w-sm break-words rounded-lg border border-border bg-surface2 p-3 text-left text-xs text-textFaint"
      }, String(this.state.erro && this.state.erro.message || this.state.erro)), /*#__PURE__*/React.createElement("button", {
        onClick: () => window.location.reload(),
        className: "mt-2 rounded-lg bg-red px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      }, "Recarregar"));
    }
    return this.props.children;
  }
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(ErroFatal, null, /*#__PURE__*/React.createElement(PortaoDeAcesso, null, /*#__PURE__*/React.createElement(App, null))));