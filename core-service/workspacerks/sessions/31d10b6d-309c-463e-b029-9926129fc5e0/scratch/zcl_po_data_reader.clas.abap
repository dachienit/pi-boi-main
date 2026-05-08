"----------------------------------------------------------------------
" Class ZCL_PO_DATA_READER
" Description: Reads Purchase Order header and item data
"----------------------------------------------------------------------
CLASS zcl_po_data_reader DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    TYPES:
      BEGIN OF ty_po_item,
        ebeln TYPE ekpo-ebeln,   " PO Number
        ebelp TYPE ekpo-ebelp,   " PO Item
        matnr TYPE ekpo-matnr,   " Material Number
        txz01 TYPE ekpo-txz01,   " Short Text
        menge TYPE ekpo-menge,   " Quantity
        meins TYPE ekpo-meins,   " Unit of Measure
        netpr TYPE ekpo-netpr,   " Net Price
        werks TYPE ekpo-werks,   " Plant
      END OF ty_po_item,
      ty_po_items TYPE STANDARD TABLE OF ty_po_item WITH EMPTY KEY.

    TYPES:
      BEGIN OF ty_po_header,
        ebeln TYPE ekko-ebeln,   " PO Number
        bukrs TYPE ekko-bukrs,   " Company Code
        bstyp TYPE ekko-bstyp,   " Document Category
        bsart TYPE ekko-bsart,   " Document Type
        lifnr TYPE ekko-lifnr,   " Vendor
        ekorg TYPE ekko-ekorg,   " Purchasing Organization
        ekgrp TYPE ekko-ekgrp,   " Purchasing Group
        bedat TYPE ekko-bedat,   " Document Date
        items TYPE ty_po_items,
      END OF ty_po_header,
      ty_po_headers TYPE STANDARD TABLE OF ty_po_header WITH EMPTY KEY.

    "! Constructor
    "! @parameter iv_bukrs | Company code filter (optional)
    METHODS constructor
      IMPORTING
        iv_bukrs TYPE bukrs OPTIONAL.

    "! Retrieve PO data for a given PO number or range
    "! @parameter it_ebeln_range | PO number selection range
    "! @parameter rt_result      | PO headers with nested items
    METHODS get_po_data
      IMPORTING
        it_ebeln_range TYPE RANGE OF ebeln
      RETURNING
        VALUE(rt_result) TYPE ty_po_headers.

  PRIVATE SECTION.

    DATA mv_bukrs TYPE bukrs.

    "! Select PO header records
    METHODS select_headers
      IMPORTING
        it_ebeln_range    TYPE RANGE OF ebeln
      RETURNING
        VALUE(rt_headers) TYPE ty_po_headers.

    "! Enrich headers with their item data
    METHODS select_items_for_headers
      CHANGING
        ct_headers TYPE ty_po_headers.

ENDCLASS.


CLASS zcl_po_data_reader IMPLEMENTATION.

  METHOD constructor.
    mv_bukrs = iv_bukrs.
  ENDMETHOD.


  METHOD get_po_data.
    rt_result = select_headers( it_ebeln_range ).
    select_items_for_headers( CHANGING ct_headers = rt_result ).
  ENDMETHOD.


  METHOD select_headers.
    IF mv_bukrs IS NOT INITIAL.
      SELECT ebeln, bukrs, bstyp, bsart, lifnr, ekorg, ekgrp, bedat
        FROM ekko
        WHERE ebeln IN @it_ebeln_range
          AND bukrs = @mv_bukrs
        INTO CORRESPONDING FIELDS OF TABLE @rt_headers.
    ELSE.
      SELECT ebeln, bukrs, bstyp, bsart, lifnr, ekorg, ekgrp, bedat
        FROM ekko
        WHERE ebeln IN @it_ebeln_range
        INTO CORRESPONDING FIELDS OF TABLE @rt_headers.
    ENDIF.
  ENDMETHOD.


  METHOD select_items_for_headers.
    CHECK ct_headers IS NOT INITIAL.

    " Collect all PO numbers
    DATA(lt_ebeln_range) = VALUE RANGE OF ebeln(
      FOR ls_hdr IN ct_headers
      ( sign = 'I' option = 'EQ' low = ls_hdr-ebeln )
    ).

    " Select all items in one go
    DATA lt_items TYPE ty_po_items.
    SELECT ebeln, ebelp, matnr, txz01, menge, meins, netpr, werks
      FROM ekpo
      WHERE ebeln IN @lt_ebeln_range
      INTO CORRESPONDING FIELDS OF TABLE @lt_items.

    " Distribute items to their headers
    LOOP AT ct_headers ASSIGNING FIELD-SYMBOL(<ls_header>).
      <ls_header>-items = VALUE #(
        FOR ls_item IN lt_items
        WHERE ( ebeln = <ls_header>-ebeln )
        ( ls_item )
      ).
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
