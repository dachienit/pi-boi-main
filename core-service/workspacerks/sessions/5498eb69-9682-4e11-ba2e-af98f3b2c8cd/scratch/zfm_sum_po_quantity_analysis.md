# Analysis of Function Module `ZFM_SUM_PO_QUANTITY`

## Original Code

```abap
FUNCTION zfm_sum_po_quantity.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     REFERENCE(IV_EBELN) TYPE  EBELN OPTIONAL
*"----------------------------------------------------------------------

  DATA: ls_ekpo TYPE ekpo,
        lt_ekpo TYPE STANDARD TABLE OF ekpo,
        lv_sum  TYPE bstmg.

  SELECT *
    FROM ekpo
    INTO TABLE lt_ekpo
  WHERE ebeln = iv_ebeln.
  IF sy-subrc IS INITIAL.
    LOOP AT lt_ekpo INTO ls_ekpo.
      lv_sum = lv_sum + ls_ekpo-menge.
    ENDLOOP.
  ENDIF.

ENDFUNCTION.
```

---

## Issues Found

| # | Severity | Issue | Clean ABAP Rule |
|---|----------|-------|----------------|
| 1 | **High** | **No output parameter** — `lv_sum` is calculated but never returned. The function has no `EXPORTING` or `RETURNING` parameter, so the result is lost. | Functional correctness |
| 2 | **High** | **`SELECT *` used** — All columns of `EKPO` are fetched into memory, but only `MENGE` is needed. This wastes network, DB, and memory resources. | *Prefer functional to procedural language constructs* |
| 3 | **Medium** | **Procedural style** — A function module is used where a class method would be cleaner, more testable, and more reusable. | *Prefer object orientation to procedural programming* |
| 4 | **Medium** | **`IV_EBELN` is OPTIONAL** — The sole input parameter is optional. Calling the FM without a PO number would select nothing meaningful. It should be mandatory. |
| 5 | **Low** | **Old-style declarations** — `DATA:` with colon-comma chaining instead of inline declarations. | *Prefer functional to procedural language constructs* |
| 6 | **Low** | **Manual aggregation via LOOP** — The sum can be computed directly in SQL with `SUM( )` or with `REDUCE`, avoiding the internal table entirely. |
| 7 | **Low** | **No error handling** — No exception raised or message issued when the PO is not found. |
| 8 | **Low** | **Unnecessary variable `ls_ekpo`** — Work area declared but could be avoided with aggregate SELECT or `REDUCE`. |

---

## Refactored Version (Clean ABAP — Class-based)

```abap
CLASS zcl_po_quantity_calculator DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    "! Sum the ordered quantity (MENGE) of all items for a Purchase Order
    "! @parameter iv_ebeln     | Purchase Order number
    "! @parameter rv_total_qty | Total quantity across all PO items
    "! @raising   cx_sy_no_data | Raised when no items found for the PO
    METHODS sum_po_quantity
      IMPORTING
        iv_ebeln           TYPE ebeln
      RETURNING
        VALUE(rv_total_qty) TYPE bstmg
      RAISING
        cx_sy_no_data.

ENDCLASS.


CLASS zcl_po_quantity_calculator IMPLEMENTATION.

  METHOD sum_po_quantity.

    SELECT SUM( menge )
      FROM ekpo
      WHERE ebeln = @iv_ebeln
      INTO @rv_total_qty.

    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE cx_sy_no_data.
    ENDIF.

  ENDMETHOD.

ENDCLASS.
```

### What changed and why

| Change | Reason |
|--------|--------|
| Class method instead of function module | Better encapsulation, testability, and reuse |
| `RETURNING` parameter added | The caller actually receives the computed sum |
| `SELECT SUM( menge )` | DB-level aggregation — no internal table, no LOOP, minimal data transfer |
| `iv_ebeln` is **mandatory** | Prevents meaningless calls without a PO number |
| `RAISING cx_sy_no_data` | Explicit error handling when no PO items exist |
| Inline declarations / modern syntax | Follows Clean ABAP guidelines |
| Removed `SELECT *` | Only the needed column (`menge`) is accessed |

---

## Keeping the Function Module (if required)

If the function module must remain (e.g., RFC interface), apply the wrapper pattern:

```abap
FUNCTION zfm_sum_po_quantity.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     REFERENCE(IV_EBELN) TYPE  EBELN
*"  EXPORTING
*"     REFERENCE(EV_TOTAL_QTY) TYPE  BSTMG
*"  EXCEPTIONS
*"     NOT_FOUND
*"----------------------------------------------------------------------

  TRY.
      ev_total_qty = NEW zcl_po_quantity_calculator( )->sum_po_quantity( iv_ebeln ).
    CATCH cx_sy_no_data.
      RAISE not_found.
  ENDTRY.

ENDFUNCTION.
```

This keeps the FM as a thin wrapper while all logic lives in the class.
