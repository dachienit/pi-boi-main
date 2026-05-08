"! <p class="shorttext synchronized">Purchase Order Data Reader</p>
"! Reads PO header and item data from EKKO / EKPO.
CLASS zcl_po_data_reader DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    TYPES:
      BEGIN OF ty_po_item,
        ebeln TYPE ekpo-ebeln,  " PO Number
        ebelp TYPE ekpo-ebelp,  " PO Item
        matnr TYPE ekpo-matnr,  " Material Number
        menge TYPE ekpo-menge,  " Quantity
        meins TYPE ekpo-meins,  " Unit of Measure
        netpr TYPE ekpo-netpr,  " Net Price
      END OF ty_po_item,

      ty_po_items TYPE STANDARD TABLE OF ty_po_item WITH EMPTY KEY,

      BEGIN OF ty_po_header,
        ebeln TYPE ekko-ebeln,  " PO Number
        bukrs TYPE ekko-bukrs,  " Company Code
        bsart TYPE ekko-bsart,  " Document Type
        lifnr TYPE ekko-lifnr,  " Vendor
        bedat TYPE ekko-bedat,  " Document Date
        items TYPE ty_po_items,
      END OF ty_po_header,

      ty_po_headers TYPE STANDARD TABLE OF ty_po_header WITH EMPTY KEY.

    "! <p class="shorttext synchronized">Read PO data by PO number(s)</p>
    "!
    "! @parameter it_ebeln | PO number range
    "! @parameter rt_result | PO headers with nested items
    METHODS get_po_data
      IMPORTING it_ebeln        TYPE RANGE OF ebeln
      RETURNING VALUE(rt_result) TYPE ty_po_headers.

  PROTECTED SECTION.
  PRIVATE SECTION.

    "! <p class="shorttext synchronized">Select PO headers</p>
    METHODS select_headers
      IMPORTING it_ebeln        TYPE RANGE OF ebeln
      RETURNING VALUE(rt_result) TYPE ty_po_headers.

    "! <p class="shorttext synchronized">Select PO items for given headers</p>
    METHODS select_items
      IMPORTING it_ebeln        TYPE RANGE OF ebeln
      RETURNING VALUE(rt_result) TYPE ty_po_items.

ENDCLASS.


CLASS zcl_po_data_reader IMPLEMENTATION.

  METHOD get_po_data.

    rt_result = select_headers( it_ebeln ).

    DATA(lt_items) = select_items( it_ebeln ).

    " Assign items to their corresponding header
    LOOP AT rt_result ASSIGNING FIELD-SYMBOL(<ls_header>).
      <ls_header>-items = VALUE #(
        FOR <item> IN lt_items
        WHERE ( ebeln = <ls_header>-ebeln )
        ( <item> )
      ).
    ENDLOOP.

  ENDMETHOD.


  METHOD select_headers.

    SELECT ebeln, bukrs, bsart, lifnr, bedat
      FROM ekko
      WHERE ebeln IN @it_ebeln
      INTO CORRESPONDING FIELDS OF TABLE @rt_result
      UP TO 1000 ROWS.

  ENDMETHOD.


  METHOD select_items.

    SELECT ebeln, ebelp, matnr, menge, meins, netpr
      FROM ekpo
      WHERE ebeln IN @it_ebeln
      INTO TABLE @rt_result
      UP TO 5000 ROWS.

  ENDMETHOD.

ENDCLASS.


*----------------------------------------------------------------------*
* Example usage (e.g. in a report or another class):
*----------------------------------------------------------------------*
* DATA(lo_reader) = NEW zcl_po_data_reader( ).
*
* DATA(lt_range) = VALUE rseloption( ( sign = 'I' option = 'EQ' low = '4500000001' ) ).
*
* DATA(lt_pos) = lo_reader->get_po_data( lt_range ).
*
* LOOP AT lt_pos ASSIGNING FIELD-SYMBOL(<po>).
*   WRITE: / <po>-ebeln, <po>-bukrs, <po>-lifnr, <po>-bedat.
*   LOOP AT <po>-items ASSIGNING FIELD-SYMBOL(<item>).
*     WRITE: /10 <item>-ebelp, <item>-matnr, <item>-menge, <item>-meins, <item>-netpr.
*   ENDLOOP.
* ENDLOOP.
