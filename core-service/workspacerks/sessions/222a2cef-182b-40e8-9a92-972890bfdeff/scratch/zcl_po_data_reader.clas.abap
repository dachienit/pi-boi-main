"----------------------------------------------------------------------
" Class ZCL_PO_DATA_READER
" Simple class to select Purchase Order data from EKKO / EKPO
"----------------------------------------------------------------------
CLASS zcl_po_data_reader DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    "-- Types ----------------------------------------------------------
    TYPES:
      BEGIN OF ty_po_item,
        ebeln TYPE ekpo-ebeln,  " PO Number
        ebelp TYPE ekpo-ebelp,  " PO Item
        matnr TYPE ekpo-matnr,  " Material Number
        txz01 TYPE ekpo-txz01,  " Short Text
        menge TYPE ekpo-menge,  " Quantity
        meins TYPE ekpo-meins,  " Unit
        netpr TYPE ekpo-netpr,  " Net Price
        werks TYPE ekpo-werks,  " Plant
      END OF ty_po_item,
      tt_po_items TYPE STANDARD TABLE OF ty_po_item WITH EMPTY KEY,

      BEGIN OF ty_po_header,
        ebeln TYPE ekko-ebeln,  " PO Number
        bukrs TYPE ekko-bukrs,  " Company Code
        bstyp TYPE ekko-bstyp,  " Document Category
        bsart TYPE ekko-bsart,  " Document Type
        lifnr TYPE ekko-lifnr,  " Vendor
        ekorg TYPE ekko-ekorg,  " Purchasing Org
        ekgrp TYPE ekko-ekgrp,  " Purchasing Group
        bedat TYPE ekko-bedat,  " Document Date
      END OF ty_po_header,
      tt_po_headers TYPE STANDARD TABLE OF ty_po_header WITH EMPTY KEY,

      BEGIN OF ty_po_data,
        headers TYPE tt_po_headers,
        items   TYPE tt_po_items,
      END OF ty_po_data.

    TYPES:
      BEGIN OF ty_po_range,
        sign   TYPE c LENGTH 1,
        option TYPE c LENGTH 2,
        low    TYPE ekko-ebeln,
        high   TYPE ekko-ebeln,
      END OF ty_po_range,
      tt_po_range TYPE STANDARD TABLE OF ty_po_range WITH EMPTY KEY.

    "-- Methods --------------------------------------------------------

    "! Select PO header + item data
    "! @parameter it_po_range | Optional range of PO numbers
    "! @parameter rs_result   | Returned PO data (headers + items)
    METHODS select_po_data
      IMPORTING
        it_po_range    TYPE tt_po_range OPTIONAL
      RETURNING
        VALUE(rs_result) TYPE ty_po_data.

  PRIVATE SECTION.

    METHODS select_headers
      IMPORTING
        it_po_range       TYPE tt_po_range OPTIONAL
      RETURNING
        VALUE(rt_headers) TYPE tt_po_headers.

    METHODS select_items
      IMPORTING
        it_headers      TYPE tt_po_headers
      RETURNING
        VALUE(rt_items) TYPE tt_po_items.

ENDCLASS.


CLASS zcl_po_data_reader IMPLEMENTATION.

  METHOD select_po_data.
    "-- 1. Read PO headers
    rs_result-headers = select_headers( it_po_range ).

    "-- 2. Read corresponding PO items
    IF rs_result-headers IS NOT INITIAL.
      rs_result-items = select_items( rs_result-headers ).
    ENDIF.
  ENDMETHOD.


  METHOD select_headers.
    IF it_po_range IS SUPPLIED AND it_po_range IS NOT INITIAL.
      SELECT ebeln, bukrs, bstyp, bsart,
             lifnr, ekorg, ekgrp, bedat
        FROM ekko
        WHERE ebeln IN @it_po_range
        ORDER BY ebeln
        INTO TABLE @rt_headers
        UP TO 1000 ROWS.
    ELSE.
      SELECT ebeln, bukrs, bstyp, bsart,
             lifnr, ekorg, ekgrp, bedat
        FROM ekko
        ORDER BY ebeln
        INTO TABLE @rt_headers
        UP TO 100 ROWS.          " safety limit when no filter given
    ENDIF.
  ENDMETHOD.


  METHOD select_items.
    IF it_headers IS INITIAL.
      RETURN.
    ENDIF.

    SELECT ebeln, ebelp, matnr, txz01,
           menge, meins, netpr, werks
      FROM ekpo
      FOR ALL ENTRIES IN @it_headers
      WHERE ebeln = @it_headers-ebeln
      ORDER BY ebeln, ebelp
      INTO TABLE @rt_items.
  ENDMETHOD.

ENDCLASS.
