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
    IF iv_ebeln IS INITIAL.
      RETURN.
    ENDIF.

    SELECT ebeln,
           ebelp,
           matnr,
           menge,
           netpr
      FROM ekpo
      INTO TABLE @result
     WHERE ebeln = @iv_ebeln.
  ENDMETHOD.

ENDCLASS.
