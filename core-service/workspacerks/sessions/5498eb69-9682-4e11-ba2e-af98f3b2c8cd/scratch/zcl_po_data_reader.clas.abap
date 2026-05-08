"----------------------------------------------------------------------
" Class ZCL_PO_DATA_READER
" Description: Simple class to select Purchase Order data
"----------------------------------------------------------------------
CLASS zcl_po_data_reader DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    TYPES:
      BEGIN OF ty_po_data,
        ebeln TYPE ekko-ebeln,   " PO Number
        bukrs TYPE ekko-bukrs,   " Company Code
        bsart TYPE ekko-bsart,   " PO Document Type
        lifnr TYPE ekko-lifnr,   " Vendor
        ebelp TYPE ekpo-ebelp,   " PO Item
        matnr TYPE ekpo-matnr,   " Material Number
        menge TYPE ekpo-menge,   " Quantity
        meins TYPE ekpo-meins,   " Unit of Measure
        netpr TYPE ekpo-netpr,   " Net Price
        werks TYPE ekpo-werks,   " Plant
      END OF ty_po_data,
      ty_po_data_tab TYPE STANDARD TABLE OF ty_po_data WITH EMPTY KEY.

    "! Retrieve PO header + item data for a given PO number range
    "! @parameter iv_ebeln_from | PO number lower bound
    "! @parameter iv_ebeln_to   | PO number upper bound (optional)
    "! @parameter rt_po_data    | Resulting PO data
    METHODS get_po_data
      IMPORTING
        iv_ebeln_from TYPE ekko-ebeln
        iv_ebeln_to   TYPE ekko-ebeln OPTIONAL
      RETURNING
        VALUE(rt_po_data) TYPE ty_po_data_tab.

  PROTECTED SECTION.
  PRIVATE SECTION.

ENDCLASS.


CLASS zcl_po_data_reader IMPLEMENTATION.

  METHOD get_po_data.

    DATA(lv_ebeln_to) = COND ekko-ebeln(
      WHEN iv_ebeln_to IS INITIAL
      THEN iv_ebeln_from
      ELSE iv_ebeln_to ).

    SELECT h~ebeln,
           h~bukrs,
           h~bsart,
           h~lifnr,
           i~ebelp,
           i~matnr,
           i~menge,
           i~meins,
           i~netpr,
           i~werks
      FROM ekko AS h
      INNER JOIN ekpo AS i
        ON h~ebeln = i~ebeln
      WHERE h~ebeln BETWEEN @iv_ebeln_from AND @lv_ebeln_to
      ORDER BY h~ebeln, i~ebelp
      INTO TABLE @rt_po_data.

  ENDMETHOD.

ENDCLASS.
