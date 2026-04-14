# Octo Project - Architecture Documentation

## Overview

- **Project**: pi-boi-main (tên gọi: Octo)
- **Identity**: AI Agent expert về SAP ABAP S4Hana, SAP ABAP on cloud, SAP ABAP refactor code (from ABAP R3 ECC to ABAP S4Hana new syntax 7.5+)
- **Platform**: SAP BTP

---

## AI Models


| Model                                 | Cost | Use Case                                                          |
| ------------------------------------- | ---- | ----------------------------------------------------------------- |
| **LLM Farm** (gpt-5-nano)             | FREE | Router, MCP                                                       |
| **DIA Brain** (Claude Opus 4.6 + RAG) | PAID | Assistant, Analysis, Refactor, Review, FixIssue, GenerateABAPCode |


### Token Optimization (DIA Brain)

- Chỉ gửi context cần thiết (transform & trim)
- Chỉ load skills liên quan

---

## Skills


| Skill                | Model     | Description                                                     |
| -------------------- | --------- | --------------------------------------------------------------- |
| **Assistant**        | DIA Brain | AI Assistant giải đáp tất cả các câu hỏi liên quan đến SAP ABAP |
| **MCP**              | LLM Farm  | Gọi SAP on-prem systems từ BTP qua MCP server                   |
| **Analysis**         | DIA Brain | Phân tích SAP ABAP objects                                      |
| **Refactor**         | DIA Brain | Refactor R3 → S4 ABAP (syntax 7.5, CleanCode)                   |
| **Review**           | DIA Brain | Review ABAP code, đề xuất cải tiến                              |
| **FixIssue**         | DIA Brain | Fix ABAP bugs dựa váo issue logs từ ATC check                   |
| **GenerateABAPCode** | DIA Brain | Tạo code ABAP tự động từ ngôn ngữ tự nhiên                      |


### Skill Definition

- Mỗi skill là file `SKILL.md` riêng với instructions
- Path: `core-service/skills/<skill-name>/SKILL.md`

### Tools

- mcp.ts, assistant.ts, analysis.ts, refactor.ts, review.ts, fixIssue.ts, generaterABAPCode.ts
- Mỗi tool `*.ts` code typescript dùng để thực thi skill tương ứng
- Path: `core-service/src/tools/<tool-name>.ts`

---

## Architecture Flow

```mermaid
flowchart TD
    A[User Input] --> B[Router - LLM Farm FREE]
    B --> C[Skill Pipeline]
    C --> D[Response tra ve User]
```

- Skill Pipeline = chuoi skills co the goi lien tiep nhau.
- Skills hien co trong pipeline: `Assistant`, `MCP`, `Analysis`, `Refactor`, `Review`, `FixIssue`, `GenerateABAPCode`.
- Skill mac dinh: neu Router khong match ro intent thi chuyen ve `Assistant`.
- Output cua skill truoc la input cua skill sau.
- Vi du chain: `MCP -> Analysis -> Refactor -> Review -> Response`.



### Router Output Mapping (Easy Read)


| Router chọn skill | Tool/Module          | Kết quả chính                   |
| ----------------- | -------------------- | ------------------------------- |
| Assistant         | assistant.ts         | Trả lời câu hỏi ABAP            |
| MCP               | mcp.ts               | Gọi SAP on-prem qua MCP         |
| Analysis          | analysis.ts          | Phân tích ABAP object           |
| Refactor          | refactor.ts          | Refactor R3 -> S4 (7.5+)        |
| Review            | review.ts            | Review code và đề xuất cải tiến |
| FixIssue          | fixIssue.ts          | Sửa lỗi theo ATC logs           |
| GenerateABAPCode | generaterABAPCode.ts | Sinh ABAP code từ prompt        |


## Implementation Tasks


| #   | Task                                    | Priority | Status |
| --- | --------------------------------------- | -------- | ------ |
| 1   | Router module (classify, select skills) | High     | Open   |
| 2   | AI Assistant                            | High     | Open   |
| 3   | MCP                                     | High     | Open   |
| 4   | Analysis                                | High     | Open   |
| 5   | Refactor                                | High     | Open   |
| 6   | Review                                  | High     | Open   |
| 7   | FixIssue                                | High     | Open   |
| 8   | GenerateABAPCode                        | High     | Open   |


---

## Technical Decisions


| Decision        | Choice                             | Reason                     |
| --------------- | ---------------------------------- | -------------------------- |
| Router logic    | LLM prompt + few-shot              | Flexible, easy to update   |
| Fallback model  | DIA Brain                          | Safer for unknown requests |
| Hybrid requests | Sequential (parallel for MCP only) | Avoid race conditions      |
| Context sharing | Transform format between models    | Different APIs             |
| Error handling  | Report to user                     | User decides next step     |


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

```text
pi-boi-main/
├─ Cursor.md         # Tài liệu kiến trúc tổng quan của dự án
├─ .gitignore        # Danh sách file/thư mục bỏ qua khi commit
├─ core-service/     # Backend + agent runtime + skill execution
└─ web-ui/           # Giao diện người dùng (frontend)
```

### core-service (Backend / Agent Runtime)

```text
core-service/
├─ src/                  # Source code chính của backend
│  ├─ main.ts            # Entry point khởi chạy service
│  ├─ agent.ts           # Logic điều phối agent chính
│  ├─ http.ts            # HTTP server / API endpoints
│  ├─ context.ts         # Quản lý context cho request/session
│  ├─ events.ts          # Event bus / luồng sự kiện nội bộ
│  ├─ slack.ts           # Tích hợp Slack (nếu bật)
│  ├─ sandbox.ts         # Cơ chế chạy tác vụ an toàn (sandbox)
│  ├─ store.ts           # Lưu trữ state / dữ liệu runtime
│  └─ tools/             # Tool implementations cho agent
├─ skills/               # Định nghĩa skills (SKILL.md + assets liên quan)
├─ docs/                 # Tài liệu kỹ thuật backend
├─ scripts/              # Scripts tiện ích/build/migrate
├─ package.json          # Dependencies và npm scripts backend
├─ tsconfig.build.json   # Cấu hình TypeScript cho build
├─ .env.example          # Mẫu biến môi trường
└─ README.md             # Hướng dẫn chạy và phát triển backend
```

### web-ui (Frontend)

```text
web-ui/
├─ src/                  # Source code chính của frontend
│  ├─ components/        # UI components tái sử dụng
│  ├─ dialogs/           # Các modal/dialog giao diện
│  ├─ tools/             # UI tool renderers + artifacts
│  ├─ storage/           # State/storage layer phía client
│  ├─ adapters/          # Adapter kết nối với backend/services
│  ├─ prompts/           # Prompt templates cho UI workflows
│  ├─ utils/             # Hàm tiện ích dùng chung
│  ├─ ChatPanel.ts       # Màn hình chat/panel chính
│  └─ index.ts           # Entry point export/khởi tạo UI
├─ example/              # Ứng dụng mẫu/demo tích hợp
├─ scripts/              # Scripts build/dev cho frontend
├─ package.json          # Dependencies và npm scripts frontend
├─ tsconfig.json         # Cấu hình TypeScript chính
├─ tsconfig.build.json   # Cấu hình TypeScript cho build output
├─ CHANGELOG.md          # Lịch sử thay đổi phiên bản
└─ README.md             # Hướng dẫn sử dụng frontend
```

