"----------------------------------------------------------------------
" Class ZCL_PO_DATA_READER
" Description: Reads Purchase Order header + item data from EKKO/EKPO
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
        bsart TYPE ekko-bsart,   " PO Type
        lifnr TYPE ekko-lifnr,   " Vendor
        aedat TYPE ekko-aedat,   " Created On
        ebelp TYPE ekpo-ebelp,   " PO Item
        matnr TYPE ekpo-matnr,   " Material
        werks TYPE ekpo-werks,   " Plant
        menge TYPE ekpo-menge,   " Quantity
        meins TYPE ekpo-meins,   " Unit
        netpr TYPE ekpo-netpr,   " Net Price
      END OF ty_po_data,
      ty_po_data_t TYPE STANDARD TABLE OF ty_po_data WITH EMPTY KEY.

    "! Retrieve PO header + item data
    "! @parameter iv_ebeln  | Optional: single PO number filter
    "! @parameter iv_bukrs  | Optional: company code filter
    "! @parameter iv_max_rows | Max rows to return (default 100)
    "! @parameter rt_po_data | Table of PO header + item records
    METHODS get_po_data
      IMPORTING
        iv_ebeln    TYPE ekko-ebeln OPTIONAL
        iv_bukrs    TYPE ekko-bukrs OPTIONAL
        iv_max_rows TYPE i DEFAULT 100
      RETURNING
        VALUE(rt_po_data) TYPE ty_po_data_t
      RAISING
        cx_sy_open_sql_db.

  PROTECTED SECTION.
  PRIVATE SECTION.

ENDCLASS.


CLASS zcl_po_data_reader IMPLEMENTATION.

  METHOD get_po_data.

    SELECT h~ebeln,
           h~bukrs,
           h~bsart,
           h~lifnr,
           h~aedat,
           i~ebelp,
           i~matnr,
           i~werks,
           i~menge,
           i~meins,
           i~netpr
      FROM ekko AS h
      INNER JOIN ekpo AS i
        ON h~ebeln = i~ebeln
      WHERE h~ebeln = @iv_ebeln OR @iv_ebeln IS INITIAL
        AND ( h~bukrs = @iv_bukrs OR @iv_bukrs IS INITIAL )
      ORDER BY h~ebeln, i~ebelp
      INTO TABLE @rt_po_data
      UP TO @iv_max_rows ROWS.

  ENDMETHOD.

ENDCLASS.
