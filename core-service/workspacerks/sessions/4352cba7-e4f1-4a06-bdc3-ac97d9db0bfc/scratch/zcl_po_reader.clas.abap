"! Purchase Order Data Reader
"! Reads PO header and item data from EKKO / EKPO.
CLASS zcl_po_reader DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    "! Purchase order header structure
    TYPES: BEGIN OF ty_po_header,
             ebeln TYPE ekko-ebeln,  " PO Number
             bukrs TYPE ekko-bukrs,  " Company Code
             bstyp TYPE ekko-bstyp,  " Document Category
             bsart TYPE ekko-bsart,  " Document Type
             lifnr TYPE ekko-lifnr,  " Vendor
             ekorg TYPE ekko-ekorg,  " Purchasing Org
             ekgrp TYPE ekko-ekgrp,  " Purchasing Group
             waers TYPE ekko-waers,  " Currency
             bedat TYPE ekko-bedat,  " Document Date
             ernam TYPE ekko-ernam,  " Created By
           END OF ty_po_header,
           ty_po_headers TYPE STANDARD TABLE OF ty_po_header WITH KEY ebeln.

    "! Purchase order item structure
    TYPES: BEGIN OF ty_po_item,
             ebeln TYPE ekpo-ebeln,  " PO Number
             ebelp TYPE ekpo-ebelp,  " PO Item
             matnr TYPE ekpo-matnr,  " Material
             txz01 TYPE ekpo-txz01,  " Short Text
             menge TYPE ekpo-menge,  " Quantity
             meins TYPE ekpo-meins,  " UoM
             netpr TYPE ekpo-netpr,  " Net Price
             werks TYPE ekpo-werks,  " Plant
             lgort TYPE ekpo-lgort,  " Storage Location
             matkl TYPE ekpo-matkl,  " Material Group
           END OF ty_po_item,
           ty_po_items TYPE STANDARD TABLE OF ty_po_item WITH KEY ebeln ebelp.

    "! Combined header + items
    TYPES: BEGIN OF ty_po_with_items,
             header TYPE ty_po_header,
             items  TYPE ty_po_items,
           END OF ty_po_with_items,
           ty_pos_with_items TYPE STANDARD TABLE OF ty_po_with_items WITH KEY header-ebeln.

    "! Constructor
    "! @parameter iv_ebeln | Single PO number filter (optional)
    "! @parameter ir_ebeln | Range of PO numbers (optional)
    METHODS constructor
      IMPORTING
        iv_ebeln TYPE ekko-ebeln OPTIONAL
        ir_ebeln TYPE RANGE OF ekko-ebeln OPTIONAL.

    "! Get PO header data
    "! @parameter rt_headers | Table of PO headers
    METHODS get_po_headers
      RETURNING VALUE(rt_headers) TYPE ty_po_headers.

    "! Get PO item data
    "! @parameter rt_items | Table of PO items
    METHODS get_po_items
      RETURNING VALUE(rt_items) TYPE ty_po_items.

    "! Get POs with their items
    "! @parameter rt_result | Combined header + items
    METHODS get_po_with_items
      RETURNING VALUE(rt_result) TYPE ty_pos_with_items.

  PRIVATE SECTION.

    DATA mt_po_range TYPE RANGE OF ekko-ebeln.
    DATA mt_headers  TYPE ty_po_headers.
    DATA mt_items    TYPE ty_po_items.
    DATA mv_loaded   TYPE abap_bool.

    "! Load data from database (lazy, called once)
    METHODS load_data.

ENDCLASS.


CLASS zcl_po_reader IMPLEMENTATION.

  METHOD constructor.
    IF iv_ebeln IS NOT INITIAL.
      mt_po_range = VALUE #( ( sign = 'I' option = 'EQ' low = iv_ebeln ) ).
    ELSEIF ir_ebeln IS NOT INITIAL.
      mt_po_range = ir_ebeln.
    ENDIF.
  ENDMETHOD.


  METHOD load_data.
    CHECK mv_loaded = abap_false.

    " Select PO headers
    SELECT ebeln, bukrs, bstyp, bsart, lifnr,
           ekorg, ekgrp, waers, bedat, ernam
      FROM ekko
      WHERE ebeln IN @mt_po_range
      ORDER BY ebeln
      INTO TABLE @mt_headers
      UP TO 1000 ROWS.                          ##CI_NOWHERE

    IF mt_headers IS NOT INITIAL.
      " Select PO items for the retrieved headers
      SELECT ebeln, ebelp, matnr, txz01, menge,
             meins, netpr, werks, lgort, matkl
        FROM ekpo
        FOR ALL ENTRIES IN @mt_headers
        WHERE ebeln = @mt_headers-ebeln
        ORDER BY ebeln, ebelp
        INTO TABLE @mt_items.
    ENDIF.

    mv_loaded = abap_true.
  ENDMETHOD.


  METHOD get_po_headers.
    load_data( ).
    rt_headers = mt_headers.
  ENDMETHOD.


  METHOD get_po_items.
    load_data( ).
    rt_items = mt_items.
  ENDMETHOD.


  METHOD get_po_with_items.
    load_data( ).

    rt_result = VALUE #(
      FOR header IN mt_headers
      ( header = header
        items  = VALUE #(
          FOR item IN mt_items
          WHERE ( ebeln = header-ebeln )
          ( item ) ) ) ).
  ENDMETHOD.

ENDCLASS.
