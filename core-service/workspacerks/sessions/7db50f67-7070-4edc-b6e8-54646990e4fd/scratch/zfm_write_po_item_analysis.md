# Analysis of `ZFM_WRITE_PO_ITEM`

## Source Code

```abap
FUNCTION zfm_write_po_item.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     REFERENCE(IV_EBELN) TYPE  EBELN OPTIONAL
*"----------------------------------------------------------------------

  DATA: lt_ekpo TYPE TABLE OF ekpo,
        ls_ekpo TYPE ekpo.

  SELECT ebeln
         ebelp
         matnr
         menge
         netpr
    FROM ekpo
    INTO TABLE lt_ekpo
   WHERE ebeln = iv_ebeln.

  IF sy-subrc = 0.
    LOOP AT lt_ekpo INTO ls_ekpo.
      WRITE: / ls_ekpo-ebeln,
               ls_ekpo-ebelp,
               ls_ekpo-matnr,
               ls_ekpo-menge,
               ls_ekpo-netpr.
    ENDLOOP.
  ENDIF.

ENDFUNCTION.
```

---

## 1. Overview

| Attribute       | Value                                      |
|-----------------|--------------------------------------------|
| **Type**        | Function Module                            |
| **Purpose**     | Read and display PO item data from `EKPO`  |
| **Input**       | `IV_EBELN` (PO number, optional)           |
| **Output**      | WRITE output (list screen)                 |
| **DB Tables**   | `EKPO` (Purchasing Document Item)          |

---

## 2. Issues Found

### 🔴 Critical Issues

#### 2.1 — Prefer Object Orientation over Procedural Programming
- **Issue:** The logic is implemented directly inside a Function Module. Clean ABAP recommends that function modules should delegate to a class method.
- **Recommendation:** Create a class (e.g., `ZCL_PO_ITEM_READER`) and move the logic there. The function module should only instantiate the class and call the method.

#### 2.2 — `IV_EBELN` is OPTIONAL but no guard clause exists
- **Issue:** The importing parameter `IV_EBELN` is marked `OPTIONAL`, meaning it can be called without a PO number. If called without a value, the `SELECT` will use an initial/empty `EBELN`, which could return unexpected results or no results silently.
- **Recommendation:** Either remove `OPTIONAL` (make it mandatory) or add a guard clause:
  ```abap
  IF iv_ebeln IS INITIAL.
    " raise exception or return early
    RETURN.
  ENDIF.
  ```

#### 2.3 — No error handling / no output parameters
- **Issue:** The function module has no `EXPORTING`, `RETURNING`, or `EXCEPTIONS` parameters. The caller has no way to know whether data was found or an error occurred.
- **Recommendation:** Add a `RETURNING` or `EXPORTING` parameter for the result data, and use class-based exceptions (`RAISING`) for error scenarios.

### 🟡 Medium Issues

#### 2.4 — Obsolete SQL syntax (no `@` host variable escaping)
- **Issue:** The `SELECT` statement uses the old-style syntax without `@`-escaped host variables and without the `INTO TABLE @DATA(...)` inline declaration.
- **Current:**
  ```abap
  SELECT ebeln ebelp matnr menge netpr
    FROM ekpo
    INTO TABLE lt_ekpo
   WHERE ebeln = iv_ebeln.
  ```
- **Recommended (New Open SQL / ABAP SQL):**
  ```abap
  SELECT ebeln, ebelp, matnr, menge, netpr
    FROM ekpo
    INTO TABLE @DATA(lt_ekpo)
   WHERE ebeln = @iv_ebeln.
  ```

#### 2.5 — Full table structure `ekpo` used instead of specific fields
- **Issue:** `lt_ekpo` is declared as `TYPE TABLE OF ekpo`, which includes all 200+ columns of `EKPO`, but only 5 fields are selected. This wastes memory.
- **Recommendation:** Define a local structure with only the needed fields, or use inline declaration with the new SQL syntax.

#### 2.6 — WRITE statement inside a Function Module
- **Issue:** Using `WRITE` for output inside a function module tightly couples the data retrieval logic with the presentation layer. This makes the function module untestable and non-reusable (e.g., cannot be called from a Web API, RFC, or background job).
- **Recommendation:** Separate concerns — return the data via an `EXPORTING`/`RETURNING` parameter and let the caller handle display.

### 🟢 Minor / Style Issues

#### 2.7 — Chained `DATA:` declaration
- **Issue:** `DATA: lt_ekpo ..., ls_ekpo ...` uses chained declaration. Clean ABAP recommends individual `DATA` statements or inline declarations.
- **Recommendation:**
  ```abap
  DATA lt_ekpo TYPE TABLE OF ekpo.
  DATA ls_ekpo TYPE ekpo.
  ```
  Or better yet, use inline declarations with `INTO TABLE @DATA(lt_ekpo)` and `LOOP AT lt_ekpo INTO DATA(ls_ekpo)`.

#### 2.8 — `sy-subrc` check could be replaced
- **Issue:** Checking `sy-subrc` after `SELECT` is valid but can be replaced by checking `lt_ekpo IS NOT INITIAL` for clarity, especially when using new SQL syntax.

---

## 3. Refactored Version (Recommended)

Below is a Clean ABAP-compliant refactored version using a class:

### Class `ZCL_PO_ITEM_READER`

```abap
CLASS zcl_po_item_reader DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    TYPES:
      BEGIN OF ty_po_item,
        ebeln TYPE ebeln,
        ebelp TYPE ebelp,
        matnr TYPE matnr,
        menge TYPE menge_d,
        netpr TYPE netpr,
      END OF ty_po_item,
      ty_po_items TYPE STANDARD TABLE OF ty_po_item WITH EMPTY KEY.

    METHODS get_items
      IMPORTING
        iv_ebeln      TYPE ebeln
      RETURNING
        VALUE(result) TYPE ty_po_items.

ENDCLASS.

CLASS zcl_po_item_reader IMPLEMENTATION.

  METHOD get_items.
    SELECT ebeln, ebelp, matnr, menge, netpr
      FROM ekpo
      INTO TABLE @result
     WHERE ebeln = @iv_ebeln.
  ENDMETHOD.

ENDCLASS.
```

### Simplified Function Module (thin wrapper)

```abap
FUNCTION zfm_write_po_item.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     REFERENCE(IV_EBELN) TYPE EBELN
*"  EXPORTING
*"     REFERENCE(ET_PO_ITEMS) TYPE ZCL_PO_ITEM_READER=>TY_PO_ITEMS
*"----------------------------------------------------------------------
  DATA(reader) = NEW zcl_po_item_reader( ).
  et_po_items = reader->get_items( iv_ebeln ).
ENDFUNCTION.
```

---

## 4. Summary

| # | Category | Issue | Severity |
|---|----------|-------|----------|
| 1 | Architecture | Logic in FM instead of class | 🔴 Critical |
| 2 | Robustness | OPTIONAL parameter without guard clause | 🔴 Critical |
| 3 | Design | No output parameters or exceptions | 🔴 Critical |
| 4 | Modernization | Old SQL syntax (no `@` escaping, no commas) | 🟡 Medium |
| 5 | Performance | Full `EKPO` structure for 5 fields | 🟡 Medium |
| 6 | Separation of Concerns | WRITE inside Function Module | 🟡 Medium |
| 7 | Style | Chained DATA declaration | 🟢 Minor |
| 8 | Style | `sy-subrc` vs `IS NOT INITIAL` | 🟢 Minor |

**Overall Assessment:** The function module works but violates several Clean ABAP principles. The main concerns are the lack of separation between data retrieval and presentation, missing error handling, and use of obsolete SQL syntax. Refactoring into a class with a thin FM wrapper would significantly improve testability, reusability, and maintainability.
