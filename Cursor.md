# Octo Project - Architecture Documentation

## Overview
- **Project**: pi-boi-main (tên gọi: Octo)
- **Identity**: AI Agent expert về SAP ABAP S4Hana, SAP ABAP on cloud
- **Platform**: SAP BTP

---

## AI Models

| Model | Cost | Use Case |
|-------|------|----------|
| **LLM Farm** (gpt-5-nano) | FREE | Router, simple tasks (MCP, analysis, fixissue) |
| **DIA Brain** (Gemini 2.5 Pro + RAG) | PAID | Complex tasks (refactor, review), escalation |

### Token Optimization (DIA Brain)
- Chỉ gửi context cần thiết (transform & trim)
- Chỉ load skills liên quan
- Router prefer LLM Farm khi có thể

---

## Skills

| Skill | Model | Description |
|-------|-------|-------------|
| **MCP** | LLM Farm | Gọi SAP on-prem systems từ BTP qua MCP server |
| **Analysis** | LLM Farm | Phân tích SAP ABAP objects |
| **FixIssue** | LLM Farm → DIA Brain | Fix ABAP bugs (escalate sau 3 lần fail) |
| **Refactor** | DIA Brain | Refactor R3 → S4 ABAP (syntax 7.5, CleanCode) |
| **Review** | DIA Brain | Review ABAP code, đề xuất cải tiến |

### Skill Definition
- Mỗi skill là file `SKILL.md` riêng với instructions
- Path: `workspace/skills/<skill-name>/SKILL.md`

---

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Input                              │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  ROUTER (LLM Farm - FREE)                                       │
│  - Few-shot prompt để classify intent                           │
│  - Output: { skills: [...], model: "farm" | "brain" }           │
│  - Default fallback: DIA Brain                                  │
└─────────────────────────────────────────────────────────────────┘
                                │
                ┌───────────────┴───────────────┐
                │                               │
                ▼                               ▼
┌───────────────────────────┐   ┌───────────────────────────────┐
│  LLM Farm (FREE)          │   │  DIA Brain (PAID)             │
│  ─────────────────────    │   │  ─────────────────────────    │
│  Skills:                  │   │  Skills:                      │
│  • MCP tools              │   │  • abap-refactor              │
│  • abap-analyzer          │   │  • abap-review                │
│  • abap-fixissue          │   │  • abap-fixissue (escalated)  │
│                           │   │                               │
│  Execution: parallel      │   │  Context: transformed & trimmed│
│  (nếu MCP)                │   │  (tối ưu tokens)              │
└───────────────────────────┘   └───────────────────────────────┘
                │                               │
                └───────────────┬───────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Response trả về User                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## FixIssue Flow (Special Case)

```
┌──────────────────────────────────────────┐
│  LLM Farm: Fix code (attempt 1)          │
└──────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│  MCP: Push code to on-prem               │
│  ATC: Check code → return issues         │
└──────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
   [No issues]             [Has issues]
        │                       │
        ▼                       ▼
      Done              attempt++ (max 3)
                                │
                    ┌───────────┴───────────┐
                    │                       │
                    ▼                       ▼
              [attempt ≤ 3]           [attempt > 3]
                    │                       │
                    ▼                       ▼
            Retry LLM Farm         Ask User: "Escalate?"
                                            │
                                ┌───────────┴───────────┐
                                │                       │
                                ▼                       ▼
                             [Yes]                    [No]
                                │                       │
                                ▼                       ▼
                        DIA Brain fix           Return current
                                │                  state
                                ▼
                        MCP push & ATC
                                │
                                ▼
                        Return result
```

---

## Implementation Tasks

| # | Task | Priority | Status |
|---|------|----------|--------|
| 1 | Router module (classify, select skills) | High | Pending |
| 2 | Multi-model support (LLM Farm + DIA Brain config) | High | Pending |
| 3 | Skill filtering (load only relevant skills) | High | Pending |
| 4 | Context transformer (convert & trim for DIA Brain) | Medium | Pending |
| 5 | FixIssue retry logic (track attempts, escalation) | Medium | Pending |
| 6 | User confirmation flow (escalation prompt) | Medium | Pending |
| 7 | MCP integration | Later | Pending |

---

## Technical Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Router logic | LLM prompt + few-shot | Flexible, easy to update |
| Fallback model | DIA Brain | Safer for unknown requests |
| Hybrid requests | Sequential (parallel for MCP only) | Avoid race conditions |
| Context sharing | Transform format between models | Different APIs |
| Error handling | Report to user | User decides next step |

---

## Configuration

### Environment Variables
```
# LLM Farm
LLM_FARM_PROVIDER=...
LLM_FARM_MODEL=gpt-5-nano
LLM_FARM_BASE_URL=...
LLM_FARM_API_KEY=...

# DIA Brain  
DIA_BRAIN_PROVIDER=...
DIA_BRAIN_MODEL=gemini-2.5-pro
DIA_BRAIN_BASE_URL=...
DIA_BRAIN_API_KEY=...
```

---

## File Structure

```
core-service/
├── src/
│   ├── agent.ts          # Main agent logic
│   ├── router.ts         # Request classifier (NEW)
│   ├── models/           # Multi-model support (NEW)
│   │   ├── index.ts
│   │   ├── llm-farm.ts
│   │   └── dia-brain.ts
│   ├── context/          # Context transformer (NEW)
│   │   └── transformer.ts
│   ├── skills/           # Skill loader with filtering (UPDATE)
│   └── ...
└── ...

workspace/
├── skills/               # Global skills
│   ├── mcp/SKILL.md
│   ├── abap-analyzer/SKILL.md
│   ├── abap-refactor/SKILL.md
│   ├── abap-review/SKILL.md
│   └── abap-fixissue/SKILL.md
└── ...
```
